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

const SERIES_ID = 2925; // Daf Yomi with Rabbi Rosner
const API_BASE = 'https://outorah.org/api/trpc/posts.fetchList';
const CONCURRENCY_LIMIT = 5;

const MASECHTA_LAST_DAF: Record<string, number> = {
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

const MASECHTOT = Object.keys(MASECHTA_LAST_DAF);

function dafWidthFor(masechta: string, dafs: number[]): number {
  const knownLast = MASECHTA_LAST_DAF[masechta] ?? 0;
  const maxDaf = Math.max(knownLast, ...dafs, 0);
  return maxDaf >= 100 ? 3 : 2;
}

interface RecordItem {
  id: number;
  title?: string;
  s3Url?: string;
}

interface Config {
  masechta: string;
  output: string;
}

const { values: args } = parseArgs({
  options: {
    masechta: { type: 'string', short: 'm' },
    output: { type: 'string', short: 'o', default: './downloads' },
  },
  allowPositionals: true,
});

async function getConfiguration(): Promise<Config> {
  let masechta = args.masechta;
  let output = args.output || './downloads';

  if (!masechta) {
    if (!process.stdout.isTTY) {
      console.error('Error: --masechta flag is required in non-interactive environments.');
      process.exit(1);
    }

    const choices = MASECHTOT.map((name) => ({ title: name, value: name }));

    const response = await prompts(
      [
        {
          type: 'autocomplete',
          name: 'masechta',
          message: 'Select or type a Masechet to download:',
          choices,
          suggest: async (input, choices) =>
            choices.filter((i) => i.title.toLowerCase().includes(input.toLowerCase())),
        },
        {
          type: 'text',
          name: 'output',
          message: 'Output directory:',
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

    masechta = response.masechta;
    output = response.output;
  }

  if (!masechta) {
    console.error('Error: No Masechet selected.');
    process.exit(1);
  }

  return { masechta, output };
}

async function fetchBatch(masechta: string, skip = 0, take = 50): Promise<RecordItem[]> {
  const inputPayload = {
    '0': {
      take,
      skip,
      platform: 'OUTorah',
      seriesId: SERIES_ID,
      masechta,
      sort: [],
    },
  };

  const url = `${API_BASE}?batch=1&input=${encodeURIComponent(JSON.stringify(inputPayload))}`;
  const response = await axios.get(url, {
    headers: {
      accept: '*/*',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      referer: `https://outorah.org/series/${SERIES_ID}`,
    },
  });

  return response.data?.[0]?.result?.data?.records || [];
}

async function downloadFile(fileUrl: string, outputPath: string): Promise<void> {
  const response = await axios({
    method: 'GET',
    url: fileUrl,
    responseType: 'stream',
  });

  await pipeline(response.data, fs.createWriteStream(outputPath));
}

function dafNumberFromTitle(title: string | undefined): number | null {
  const match = title?.match(/(\d+)\s*$/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function paddedDaf(daf: number, width: number): string {
  return String(daf).padStart(width, '0');
}

function fileNameForTrack(masechta: string, item: RecordItem, dafWidth: number): string {
  const daf = dafNumberFromTitle(item.title);
  if (daf !== null) {
    return `${masechta} ${paddedDaf(daf, dafWidth)}.mp3`;
  }

  const safeTitle = (item.title || `track_${item.id}`).replace(/[/\\?%*:|"<>]/g, '-');
  return `${safeTitle}.mp3`;
}

async function main(): Promise<void> {
  const { masechta, output } = await getConfiguration();
  const targetDir = path.resolve(output, masechta);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  console.log(`\n[+] Fetching track metadata for ${masechta}...`);

  let skip = 0;
  const allRecords: RecordItem[] = [];
  let hasMore = true;

  while (hasMore) {
    const records = await fetchBatch(masechta, skip, 50);
    if (records.length === 0) {
      hasMore = false;
    } else {
      allRecords.push(...records);
      skip += 50;
    }
  }

  const validRecords = allRecords.filter((item) => Boolean(item.s3Url));
  console.log(`[+] Total tracks found: ${validRecords.length}`);

  if (validRecords.length === 0) {
    console.log('No downloadable tracks found.');
    return;
  }

  const dafs = validRecords
    .map((item) => dafNumberFromTitle(item.title))
    .filter((daf): daf is number => daf !== null);
  const dafWidth = dafWidthFor(masechta, dafs);

  // Initialize progress bar
  const progressBar = new cliProgress.SingleBar(
    {
      format: 'Downloading [{bar}] {percentage}% | {value}/{total} Tracks | Current: {filename}',
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
          progressBar.start(validRecords.length, progressBar.value, { filename: fileName.substring(0, 25) });
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