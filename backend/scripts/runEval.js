// Evaluation runner for the extraction prompt. Runs eval/dataset.json
// against the live Gemini extraction layer, grades each case with
// eval/grader.js, and prints a breakdown by tag - not just an overall
// pass rate - so failure patterns are visible before any prompt tuning
// happens. Also writes a JSON report to eval-results/ for comparing
// pass rates across prompt versions over time.
//
// Usage:
//   npm run eval
//
// Known-gap cases (tagged via dataset "knownGap": true - currently
// date_relative and multi_item, see eval/dataset.json) are graded like
// everything else, but reported in a SEPARATE section so they don't blend
// into the "core AI accuracy" number. They represent product scope gaps
// (no date field, no multi-transaction-per-message support), not
// extraction quality problems - see the discussion that led to this file.
//
// Rate-limited on purpose (REQUEST_SPACING_MS) - same reasoning as
// test/integration/aiExtraction.test.js.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiProvider } from '../src/ai/aiProvider.js';
import { EXTRACTION_PROMPT_VERSION } from '../src/ai/extractionPrompt.js';
import { gradeExtraction } from '../eval/grader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUEST_SPACING_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDataset() {
  const raw = fs.readFileSync(path.join(__dirname, '../eval/dataset.json'), 'utf-8');
  return JSON.parse(raw);
}

function summarizeByTag(results) {
  const byTag = {};
  for (const r of results) {
    for (const tag of r.case.tags) {
      byTag[tag] ??= { total: 0, pass: 0 };
      byTag[tag].total += 1;
      if (r.grade.pass) byTag[tag].pass += 1;
    }
  }
  return byTag;
}

function printSummary(label, results) {
  const total = results.length;
  const passed = results.filter((r) => r.grade.pass).length;
  const rate = total === 0 ? 'n/a' : `${((passed / total) * 100).toFixed(1)}%`;

  console.log(`\n=== ${label}: ${passed}/${total} passed (${rate}) ===`);

  const byTag = summarizeByTag(results);
  for (const [tag, stats] of Object.entries(byTag)) {
    const tagRate = ((stats.pass / stats.total) * 100).toFixed(0);
    console.log(`  ${tag.padEnd(20)} ${stats.pass}/${stats.total} (${tagRate}%)`);
  }

  const failures = results.filter((r) => !r.grade.pass);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) {
      console.log(`  - [${f.case.id}] "${f.case.input}"`);
      for (const reason of f.grade.failures) {
        console.log(`      ${reason}`);
      }
    }
  }
}

async function main() {
  const dataset = loadDataset();
  console.log(`Running eval: ${dataset.length} cases, prompt version ${EXTRACTION_PROMPT_VERSION}`);
  console.log(`Spacing ${REQUEST_SPACING_MS}ms between calls - this will take a few minutes.\n`);

  const results = [];

  for (const testCase of dataset) {
    await sleep(REQUEST_SPACING_MS);
    process.stdout.write(`  running [${testCase.id}] "${testCase.input}"... `);

    try {
      const result = await aiProvider.extract(testCase.input, testCase.context || null);
      const grade = gradeExtraction(result, testCase.expect);
      results.push({ case: testCase, result, grade });
      console.log(grade.pass ? 'PASS' : 'FAIL');
    } catch (err) {
      results.push({
        case: testCase,
        result: null,
        grade: { pass: false, failures: [`threw an error: ${err.message}`] },
      });
      console.log('ERROR');
    }
  }

  const coreResults = results.filter((r) => !r.case.knownGap);
  const knownGapResults = results.filter((r) => r.case.knownGap);

  printSummary('CORE ACCURACY (excludes known product-scope gaps)', coreResults);
  if (knownGapResults.length > 0) {
    printSummary('KNOWN GAPS (not counted toward core accuracy - see dataset knownGapNote)', knownGapResults);
  }

  // Save a report for tracking pass rate across prompt versions over time.
  const outDir = path.join(__dirname, '../eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${timestamp}_${EXTRACTION_PROMPT_VERSION}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        promptVersion: EXTRACTION_PROMPT_VERSION,
        runAt: new Date().toISOString(),
        coreAccuracy: {
          total: coreResults.length,
          passed: coreResults.filter((r) => r.grade.pass).length,
        },
        results: results.map((r) => ({
          id: r.case.id,
          input: r.case.input,
          tags: r.case.tags,
          knownGap: Boolean(r.case.knownGap),
          pass: r.grade.pass,
          failures: r.grade.failures,
          result: r.result,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nReport saved to ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error('Eval run failed:', err);
  process.exit(1);
});
