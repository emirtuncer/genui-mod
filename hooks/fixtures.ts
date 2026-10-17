/** A vitest --reporter=json result: two passed, one failed in src/a.test.ts. */
export const VITEST = {
  numTotalTests: 3,
  numPassedTests: 2,
  numFailedTests: 1,
  numPendingTests: 0,
  testResults: [
    {
      name: 'src/a.test.ts',
      status: 'failed',
      assertionResults: [
        { fullName: 'a adds', status: 'failed' },
        { fullName: 'a subtracts', status: 'passed' },
      ],
    },
  ],
}
