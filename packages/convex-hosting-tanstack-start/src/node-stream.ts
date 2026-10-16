// What `node:stream` resolves to in the server build. TanStack's stream renderer imports Node's
// stream classes at the top of its files for its Node branch, which runs only where React has no
// Web Stream renderer; on Convex, React's `renderToReadableStream` exists, so that branch never
// runs, and Convex's bundler has no `node:stream` to resolve. These classes are never called.

function notOnConvex(): never {
  throw new Error(
    "node:stream is not available on Convex; TanStack's Web Stream path does not use it.",
  );
}

export class Readable {
  static toWeb(): never {
    return notOnConvex();
  }

  static fromWeb(): never {
    return notOnConvex();
  }
}

export class PassThrough {
  constructor() {
    notOnConvex();
  }
}
