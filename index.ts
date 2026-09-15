import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { pipeline } from 'stream/promises';
import { parseArgs } from 'util';
import axios from 'axios';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';
import prompts from 'prompts';

// Trust OS CAs so corporate SSL inspection / extra roots work on Windows.
try {
  tls.setDefaultCACertificates([
    ...tls.getCACertificates('default'),
    ...tls.getCACertificates('system'),
  ]);
} catch {
  // Node versions without getCACertificates/setDefaultCACertificates.
}

export type Edition = 'Bavli' | 'Yerushalmi';

export interface EditionInfo {
  name: Edition;
  seriesId: number;
  startDaf: number;
  subDir: string;
}

export const EDITIONS: Record<Edition, EditionInfo> = {
  Bavli: {
    name: 'Bavli',
    seriesId: 2925,
    startDaf: 2,
    subDir: 'bavli',
  },
  Yerushalmi: {
    name: 'Yerushalmi',
    seriesId: 6076,
    startDaf: 1,
    subDir: 'yerushalmi',
  },
};

const API_BASE = 'https://outorah.org/api/trpc/posts.fetchList';
const CONCURRENCY_LIMIT = 5;

export const BAVLI_MASECHTA_LAST_DAF: Record<string, number> = {
  Berachos: 64,
  Shabbos: 157,
  Eruvin: 105,
  Pesachim: 121,
  Shekalim: 22,
  Yoma: 88,
  Succah: 56,
  Beitzah: 40,
  'Rosh Hashanah': 35,
  Taanis: 31,
  Megilah: 32,
  'Moed Katan': 29,
  Chagiga: 27,
  Yevamos: 122,
  Kesuvos: 112,
  Nedarim: 91,
  Nazir: 66,
  Sotah: 49,
  Gitin: 90,
  Kidushin: 82,
  'Bava Kama': 119,
  'Bava Metzia': 119,
  'Bava Basra': 176,
  Sanhedrin: 113,
  Makos: 24,
  Shevuos: 49,
  'Avodah Zarah': 76,
  Horayos: 14,
  Zevachim: 120,
  Menachos: 110,
  Chulin: 142,
  Bechoros: 61,
  Erchin: 34,
  Temurah: 34,
  Kerisus: 28,
  Meilah: 22,
  Nidah: 73,
};

export const BAVLI_MASECHTOT = Object.keys(BAVLI_MASECHTA_LAST_DAF);

// Complete 39 tractates and Oz VeHadar page counts for Talmud Yerushalmi
export const YERUSHALMI_MASECHTA_LAST_DAF: Record<string, number> = {
  // Seder Zeraim (11)
  Berachos: 94,
  Peah: 73,
  Demai: 77,
  Kilayim: 84,
  "Shevi'is": 87,
  Terumos: 107,
  Maasros: 46,
  'Maaser Sheni': 59,
  Challah: 49,
  Orlah: 42,
  Bikkurim: 26,
  // Seder Moed (12)
  Shabbos: 113,
  Eruvin: 71,
  Pesachim: 88,
  Shekalim: 61,
  Yoma: 57,
  Succah: 33,
  Beitzah: 49,
  'Rosh Hashnah': 27,
  Taanis: 31,
  Megillah: 41,
  Chagigah: 29,
  'Moed Kattan': 24,
  // Seder Nashim (7)
  Yevamos: 85,
  Kesuvos: 72,
  Nedarim: 47,
  Nazir: 40,
  Sotah: 47,
  Gitin: 54,
  Kidushin: 48,
  // Seder Nezikin (8)
  'Bava Kama': 44,
  'Bava Metzia': 37,
  'Bava Basra': 34,
  Sanhedrin: 44,
  Makos: 9,
  Shevuos: 57,
  'Avodah Zarah': 37,
  Horayos: 19,
  // Seder Taharos (1)
  Nidah: 13,
};

export const YERUSHALMI_MASECHTOT = Object.keys(YERUSHALMI_MASECHTA_LAST_DAF);

export function normalizeMasechtaName(input: string, edition: Edition): string {
  const trimmed = input.trim();
  const list = edition === 'Yerushalmi' ? YERUSHALMI_MASECHTOT : BAVLI_MASECHTOT;
  const exact = list.find((m) => m.toLowerCase() === trimmed.toLowerCase());
  if (exact) {
    return exact;
  }

  // Handle common spelling variations between OUTorah and users
  const lower = trimmed.toLowerCase();
  if (edition === 'Yerushalmi') {
    if (lower === 'rosh hashanah') return 'Rosh Hashnah';
    if (lower === 'moed katan') return 'Moed Kattan';
    if (lower === 'sheviis' || lower === 'sheviit') return "Shevi'is";
    if (lower === 'megilah') return 'Megillah';
    if (lower === 'chagiga') return 'Chagigah';
  } else {
    if (lower === 'rosh hashnah') return 'Rosh Hashanah';
    if (lower === 'moed kattan') return 'Moed Katan';
    if (lower === 'megillah') return 'Megilah';
    if (lower === 'chagigah') return 'Chagiga';
  }

  return trimmed;
}

export function dafWidthFor(
  edition: Edition,
  masechta: string,
  dafs: number[],
  queryTotal?: number
): number {
  const knownLast =
    edition === 'Yerushalmi'
      ? YERUSHALMI_MASECHTA_LAST_DAF[masechta] ?? 0
      : BAVLI_MASECHTA_LAST_DAF[masechta] ?? 0;
  const maxDaf = Math.max(knownLast, queryTotal ?? 0, ...dafs, 0);
  return maxDaf >= 100 ? 3 : 2;
}

export interface RecordItem {
  id: number;
  title?: string;
  s3Url?: string;
}

export interface BatchResult {
  records: RecordItem[];
  total: number;
}

export interface Config {
  edition: Edition;
  masechta: string;
  output: string;
}

const { values: args } = parseArgs({
  options: {
    edition: { type: 'string', short: 'e' },
    type: { type: 'string', short: 't' },
    yerushalmi: { type: 'boolean', short: 'y' },
    bavli: { type: 'boolean', short: 'b' },
    masechta: { type: 'string', short: 'm' },
    output: { type: 'string', short: 'o', default: './downloads' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

if (args.help) {
  console.log(`
Usage: node index.ts [options]

Options:
  -e, --edition <edition>   Select edition ('bavli' or 'yerushalmi')
  -y, --yerushalmi          Download Yerushalmi shiurim (Series 6076)
  -b, --bavli               Download Bavli shiurim (Series 2925)
  -m, --masechta <masechta> Masechet name (e.g. Berachos)
  -o, --output <dir>        Base output directory (default: ./downloads)
  -h, --help                Show this help message
`);
  process.exit(0);
}

export async function getConfiguration(): Promise<Config> {
  let editionArg: Edition | undefined;
  if (
    args.yerushalmi ||
    args.edition?.toLowerCase() === 'yerushalmi' ||
    args.type?.toLowerCase() === 'yerushalmi'
  ) {
    editionArg = 'Yerushalmi';
  } else if (
    args.bavli ||
    args.edition?.toLowerCase() === 'bavli' ||
    args.type?.toLowerCase() === 'bavli'
  ) {
    editionArg = 'Bavli';
  }

  let masechta = args.masechta;
  let output = args.output || './downloads';

  // If masechta is passed via CLI without edition, auto-detect if uniquely Yerushalmi
  if (masechta && !editionArg) {
    const isYerushalmiOnly = YERUSHALMI_MASECHTOT.some(
      (y) =>
        y.toLowerCase() === masechta?.toLowerCase() &&
        !BAVLI_MASECHTOT.some((b) => b.toLowerCase() === masechta?.toLowerCase())
    );
    if (isYerushalmiOnly) {
      editionArg = 'Yerushalmi';
    }
  }

  let edition = editionArg;

  if (!edition || !masechta) {
    if (!process.stdout.isTTY) {
      console.error(
        'Error: --masechta flag is required in non-interactive environments (and optionally --edition/--yerushalmi/--bavli).'
      );
      process.exit(1);
    }

    const response = await prompts(
      [
        {
          type: edition ? null : 'select',
          name: 'edition',
          message: 'Select Talmud edition:',
          choices: [
            { title: 'Talmud Bavli (Daf Yomi)', value: 'Bavli' },
            { title: 'Talmud Yerushalmi (Yerushalmi Yomi)', value: 'Yerushalmi' },
          ],
          initial: 0,
        },
        {
          type: masechta ? null : 'autocomplete',
          name: 'masechta',
          message: (prev, values) => {
            const currentEdition = edition || values.edition;
            return `Select or type a ${currentEdition} Masechet to download:`;
          },
          choices: (prev, values) => {
            const currentEdition: Edition = edition || values.edition;
            const list =
              currentEdition === 'Yerushalmi' ? YERUSHALMI_MASECHTOT : BAVLI_MASECHTOT;
            return list.map((name) => ({ title: name, value: name }));
          },
          suggest: async (input, choices) =>
            choices.filter((i) => i.title.toLowerCase().includes(input.toLowerCase())),
        },
        {
          type: 'text',
          name: 'output',
          message: 'Base output directory:',
          initial: output,
        },
      ],
      {
        onCancel: () => {
          console.log('\nOperation cancelled.');
          process.exit(0);
        },
      }
    );

    edition = edition || response.edition;
    masechta = masechta || response.masechta;
    output = response.output || output;
  }

  if (!edition) {
    edition = 'Bavli';
  }

  if (!masechta) {
    console.error('Error: No Masechet selected.');
    process.exit(1);
  }

  masechta = normalizeMasechtaName(masechta, edition);

  return { edition, masechta, output };
}

export async function fetchBatch(
  seriesId: number,
  masechta: string,
  skip = 0,
  take = 50
): Promise<BatchResult> {
  const inputPayload = {
    '0': {
      take,
      skip,
      platform: 'OUTorah',
      seriesId,
      masechta,
      sort: [],
    },
  };

  const url = `${API_BASE}?batch=1&input=${encodeURIComponent(JSON.stringify(inputPayload))}`;
  const response = await axios.get(url, {
    headers: {
      accept: '*/*',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      referer: `https://outorah.org/series/${seriesId}`,
    },
  });

  const data = response.data?.[0]?.result?.data;
  return {
    records: data?.records || [],
    total: typeof data?.total === 'number' ? data.total : 0,
  };
}

export async function downloadFile(fileUrl: string, outputPath: string): Promise<void> {
  const response = await axios({
    method: 'GET',
    url: fileUrl,
    responseType: 'stream',
  });

  await pipeline(response.data, fs.createWriteStream(outputPath));
}

export function dafNumberFromTitle(title: string | undefined): number | null {
  const match = title?.match(/(\d+)\s*$/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

export function paddedDaf(daf: number, width: number): string {
  return String(daf).padStart(width, '0');
}

export function fileNameForTrack(masechta: string, item: RecordItem, dafWidth: number): string {
  const daf = dafNumberFromTitle(item.title);
  if (daf !== null) {
    return `${masechta} ${paddedDaf(daf, dafWidth)}.mp3`;
  }

  const safeTitle = (item.title || `track_${item.id}`).replace(/[/\\?%*:|"<>]/g, '-');
  return `${safeTitle}.mp3`;
}

async function main(): Promise<void> {
  const { edition, masechta, output } = await getConfiguration();
  const seriesInfo = EDITIONS[edition];

  // Store in dedicated folder per edition to prevent clashing (e.g. downloads/yerushalmi/Berachos)
  const targetDir = path.resolve(output, seriesInfo.subDir, masechta);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  console.log(
    `\n[+] Fetching track metadata for ${edition} ${masechta} (Series ${seriesInfo.seriesId})...`
  );
  console.log(`[+] Destination folder: ${targetDir}`);

  let skip = 0;
  const allRecords: RecordItem[] = [];
  let hasMore = true;
  let queryTotal = 0;

  while (hasMore) {
    const batch = await fetchBatch(seriesInfo.seriesId, masechta, skip, 50);
    queryTotal = batch.total;

    if (batch.records.length === 0) {
      hasMore = false;
    } else {
      allRecords.push(...batch.records);
      skip += 50;
      if (queryTotal > 0 && allRecords.length >= queryTotal) {
        hasMore = false;
      }
    }
  }

  const validRecords = allRecords.filter((item) => Boolean(item.s3Url));
  console.log(`[+] Total tracks reported by OUTorah: ${queryTotal}`);
  console.log(`[+] Downloadable tracks found: ${validRecords.length}`);

  if (validRecords.length === 0) {
    console.log('No downloadable tracks found.');
    return;
  }

  const dafs = validRecords
    .map((item) => dafNumberFromTitle(item.title))
    .filter((daf): daf is number => daf !== null);
  const dafWidth = dafWidthFor(edition, masechta, dafs, queryTotal);

  // Missing dafim detection based on start daf (1 for Yerushalmi, 2 for Bavli)
  const startDaf = seriesInfo.startDaf;
  const dafSet = new Set(dafs);
  const maxDetectedDaf = Math.max(queryTotal, ...dafs, 0);
  const missingDafs: number[] = [];
  for (let d = startDaf; d <= maxDetectedDaf; d++) {
    if (!dafSet.has(d)) {
      missingDafs.push(d);
    }
  }
  if (missingDafs.length > 0 && missingDafs.length < maxDetectedDaf) {
    console.log(
      `[!] Note: Missing dafim on OUTorah (${missingDafs.length}): ${missingDafs.join(', ')}`
    );
  }

  // Initialize progress bar
  const progressBar = new cliProgress.SingleBar(
    {
      format: `Downloading [{bar}] {percentage}% | {value}/{total} Tracks (${edition}) | Current: {filename}`,
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );

  progressBar.start(validRecords.length, 0, { filename: 'Starting...' });

  const limit = pLimit(CONCURRENCY_LIMIT);

  // Map download tasks through p-limit concurrency wrapper
  const downloadTasks = validRecords.map((item) =>
    limit(async () => {
      const fileName = fileNameForTrack(masechta, item, dafWidth);
      const targetFilePath = path.join(targetDir, fileName);

      progressBar.update({ filename: fileName.substring(0, 25) });

      if (!fs.existsSync(targetFilePath) && item.s3Url) {
        try {
          await downloadFile(item.s3Url, targetFilePath);
        } catch (err: unknown) {
          // Log errors non-destructively without breaking the progress bar
          progressBar.stop();
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(`\n[-] Failed to download ${fileName}: ${errorMessage}`);
          progressBar.start(validRecords.length, progressBar.value, {
            filename: fileName.substring(0, 25),
          });
        }
      }

      progressBar.increment();
    })
  );

  await Promise.all(downloadTasks);
  progressBar.stop();

  console.log('\n[✔] All downloads completed!');
}

main().catch(console.error);