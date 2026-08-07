// Bulk enrolment from a CSV. Same logic the webhook and cron use — see
// lib/enroll.js — so behaviour cannot drift between batch and automated runs.
//
//   node --env-file=.env enrollment.js [--dry-run] [--file=x.csv] [--out=y.csv]
//                                      [--limit=N] [--delay=ms]

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { assertConfigured, config } from './lib/vivenu.js';
import { enrollCustomer } from './lib/enroll.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};
const CSV_FILE_PATH = flag('file', './customers.csv');
const RESULTS_PATH = flag('out', './results.csv');
const DRY_RUN = flag('dry-run', false) === true;
const LIMIT = Number(flag('limit', Infinity));
const DELAY_MS = Number(flag('delay', 300));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readCustomers(filePath) {
  const file = fs.readFileSync(path.resolve(filePath), 'utf8');
  const rows = parse(file, {
    columns: (header) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const missing = rows.findIndex((r) => !r.customerId);
  if (missing !== -1) throw new Error(`Row ${missing + 2} of ${filePath} has no customerId`);
  return rows;
}

function writeResults(results) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = results
    .map((r) => [r.customerId, r.status, r.membershipId, r.externalCode, r.reason].map(esc).join(','))
    .join('\n');
  fs.writeFileSync(path.resolve(RESULTS_PATH), `customerId,status,membershipId,externalCode,reason\n${body}\n`);
  console.log(`\nResults written to ${RESULTS_PATH}`);
}

async function run() {
  try {
    assertConfigured();
  } catch (err) {
    console.error(`${err.message}\nRun with: node --env-file=.env enrollment.js`);
    process.exitCode = 1;
    return;
  }

  const rows = readCustomers(CSV_FILE_PATH).slice(0, LIMIT);
  console.log(
    `Environment: ${config.env}  |  program: ${config.programId}  |  access list: ${config.accessListId}` +
      `${DRY_RUN ? '  |  DRY RUN' : ''}`,
  );
  if (config.requiredTags.length) {
    console.log(`Eligibility: customer must have tag(s) ${config.requiredTags.join(' AND ')}`);
  } else {
    console.warn(
      'WARNING: VIVENU_REQUIRED_TAGS is empty, so no eligibility check runs. The API does ' +
        "not enforce the program's Customer Segment on its own.",
    );
  }
  console.log(`Found ${rows.length} customer(s) in ${CSV_FILE_PATH}.`);

  const results = [];
  for (const row of rows) {
    console.log(`\nProcessing customer ${row.customerId}...`);

    try {
      results.push(await enrollCustomer(row.customerId, { log: console.log, dryRun: DRY_RUN }));
    } catch (error) {
      console.error(`  [ERROR] ${error.message}`);
      results.push({
        customerId: row.customerId,
        status: 'failed',
        membershipId: '',
        externalCode: '',
        reason: error.message,
      });
    }
    await delay(DELAY_MS);
  }

  writeResults(results);

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(
    DRY_RUN
      ? `\nDone (dry run): ${count('would-enrol')} would be enrolled, ${count('not-eligible')} not eligible, ` +
          `${count('failed')} failed.`
      : `\nDone: ${count('enrolled')} enrolled, ${count('already-enrolled')} already enrolled, ` +
          `${count('not-eligible')} not eligible, ${count('failed')} failed.`,
  );
  if (count('failed')) process.exitCode = 1;
}

run();
