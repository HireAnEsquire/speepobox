// A smart-HTTP git server on 127.0.0.1, behind basic auth (T132). A local
// path or `file://` mirror never makes git ask a credential helper anything,
// so it cannot show which helper answered; this can. Every request without
// the one credential it was started with gets a 401, and every request with
// it is handed to `git http-backend` as CGI. No network, no TLS: the origin
// is `http://127.0.0.1:<port>`, and the code under test derives the
// credential origin from the URL it reaches, so the pair scopes to it.
//
// The backend is spawned with `node:child_process` like the shim tests'
// children: it is the server's own child, not one the package spawns.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Credential {
  readonly username: string;
  readonly password: string;
}

export interface GitHttpServer {
  // The URL of `<root>/<name>`, as git should be pointed at it.
  readonly url: (name: string) => string;
  readonly close: () => Promise<void>;
}

const backend = (
  root: string,
  request: IncomingMessage,
  body: Buffer,
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}> =>
  new Promise((resolve, reject) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const header = (name: string): Record<string, string> => {
      const value = request.headers[name.toLowerCase()];
      return typeof value === "string" ? { [name]: value } : {};
    };
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
        ...(request.headers["content-type"] === undefined
          ? {}
          : { CONTENT_TYPE: request.headers["content-type"] }),
        CONTENT_LENGTH: String(body.length),
        ...Object.fromEntries(
          Object.entries(header("Content-Encoding")).map(([, v]) => ["HTTP_CONTENT_ENCODING", v]),
        ),
        ...Object.fromEntries(
          Object.entries(header("Git-Protocol")).map(([, v]) => ["GIT_PROTOCOL", v]),
        ),
      },
    });
    const chunks: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const [head, rest] =
        split === -1
          ? [output.toString("utf8"), Buffer.alloc(0)]
          : [output.subarray(0, split).toString("utf8"), output.subarray(split + 4)];
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      resolve({ status, headers, body: rest });
    });
    child.stdin.end(body);
  });

// Serves every repository under `root` to a request carrying `credential`.
export const serveGitHttp = (root: string, credential: Credential): Promise<GitHttpServer> =>
  new Promise((resolve) => {
    const expected = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.headers.authorization !== expected) {
          response.writeHead(401, { "WWW-Authenticate": 'Basic realm="speepobox"' }).end();
          return;
        }
        backend(root, request, Buffer.concat(chunks)).then(
          (answer) => response.writeHead(answer.status, answer.headers).end(answer.body),
          () => response.writeHead(500).end(),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: (name) => `http://127.0.0.1:${port}/${name}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });

// A fake `gh`, alone in a directory to put on a `PATH`. Every call appends its
// argv to the log; `auth git-credential get` answers `credential` when it has
// one and fails the way a logged-out gh does when it has none.
export const fakeGh = (
  credential: Credential | undefined,
): { readonly dir: string; readonly calls: () => ReadonlyArray<string> } => {
  const dir = mkdtempSync(join(tmpdir(), "speepobox-fake-gh-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const answer =
    credential === undefined
      ? "exit 1"
      : `printf 'username=%s\\npassword=%s\\n' '${credential.username}' '${credential.password}'`;
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      "while IFS= read -r _; do :; done",
      'if [ "$*" = "auth git-credential get" ]; then',
      `  ${answer}`,
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  return {
    dir,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
};

// A `HOME` whose global git config names one credential helper of the
// operator's own — answering `credential` when it has one — and logs every
// action git sends it, `store` included.
export const operatorHome = (
  credential: Credential | undefined,
): { readonly home: string; readonly actions: () => ReadonlyArray<string> } => {
  const home = mkdtempSync(join(tmpdir(), "speepobox-home-"));
  const log = join(home, "helper.log");
  writeFileSync(log, "");
  const helper = join(home, "helper");
  const answer =
    credential === undefined
      ? ""
      : `[ "$1" = get ] && printf 'username=%s\\npassword=%s\\n' '${credential.username}' '${credential.password}'`;
  writeFileSync(
    helper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$1" >> '${log}'`,
      "while IFS= read -r _; do :; done",
      answer,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  // The empty `helper =` resets the list git has gathered so far, so the
  // chain is this one helper alone. Without it the system config's helpers
  // still run — Homebrew's git names `osxkeychain` there, which under a temp
  // `HOME` answers the fallback's `store` with a Keychain Not Found modal and
  // the case hangs until it times out.
  writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper =\n\thelper = ${helper}\n`);
  return {
    home,
    actions: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
};
