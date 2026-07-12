// Pure grading logic for the extraction evaluation dataset. No I/O, no
// Gemini calls - directly unit-testable. See scripts/runEval.js for the
// runner that actually calls the AI and uses this to grade results.
//
// Grading is field-by-field and flexible on purpose: exact-match fields
// (amount, is_continuation, is_correction) alongside "one of" fields
// (typeOneOf, confidenceOneOf) and category lists (acceptableCategories,
// since category assignment can be legitimately ambiguous in a way that
// amount/direction cannot).

/**
 * result: the object returned by aiProvider.extract() (or an equivalent
 *   fixture in tests)
 * expect: the "expect" block from an eval/dataset.json case
 *
 * Returns { pass: boolean, failures: string[] } - failures is a list of
 * human-readable mismatch descriptions, empty when pass is true.
 */
export function gradeExtraction(result, expect) {
  const failures = [];

  if (expect.type !== undefined && result.type !== expect.type) {
    failures.push(`type: expected "${expect.type}", got "${result.type}"`);
  }
  if (expect.typeOneOf !== undefined && !expect.typeOneOf.includes(result.type)) {
    failures.push(`type: expected one of [${expect.typeOneOf.join(', ')}], got "${result.type}"`);
  }

  if (expect.amount !== undefined && result.amount !== expect.amount) {
    failures.push(`amount: expected ${expect.amount}, got ${result.amount}`);
  }
  if (expect.amountPresent === true && (result.amount === undefined || result.amount === null)) {
    failures.push('amount: expected a value to be present, got none');
  }
  if (expect.amountPresent === false && result.amount !== undefined && result.amount !== null) {
    failures.push(`amount: expected no value, got ${result.amount}`);
  }

  if (
    expect.acceptableCategories !== undefined &&
    !expect.acceptableCategories.includes(result.category)
  ) {
    failures.push(
      `category: expected one of [${expect.acceptableCategories.join(', ')}], got "${result.category}"`,
    );
  }

  if (expect.confidence !== undefined && result.confidence !== expect.confidence) {
    failures.push(`confidence: expected "${expect.confidence}", got "${result.confidence}"`);
  }
  if (expect.confidenceOneOf !== undefined && !expect.confidenceOneOf.includes(result.confidence)) {
    failures.push(
      `confidence: expected one of [${expect.confidenceOneOf.join(', ')}], got "${result.confidence}"`,
    );
  }

  if (expect.is_continuation !== undefined && result.is_continuation !== expect.is_continuation) {
    failures.push(
      `is_continuation: expected ${expect.is_continuation}, got ${result.is_continuation}`,
    );
  }
  if (expect.is_correction !== undefined && result.is_correction !== expect.is_correction) {
    failures.push(`is_correction: expected ${expect.is_correction}, got ${result.is_correction}`);
  }

  return { pass: failures.length === 0, failures };
}
