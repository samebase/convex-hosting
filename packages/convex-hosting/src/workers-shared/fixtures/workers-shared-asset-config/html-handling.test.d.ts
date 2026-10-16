// The module that the test-cases files import their type from, at the path upstream gives it. The
// test itself is src/component/conformance.test.ts.
export type TestCase = {
  title: string;
  files: string[];
  requestPath: string;
  matchedFile?: string;
  finalPath?: string;
};
