// The pin grammar (T121) against the fixture lines under `test/fixtures/pin/`,
// which the shim's `sed` is held to as well (T125): the directory a case sits
// in is its expected verdict, so every case is read off disk rather than
// written here, and a case added there is asserted here without an edit.
import { describe, expect, it } from "@effect/vitest";
import { Either } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import {
  pinIn,
  pinLineIn,
  RELEASE_URL,
  renderPinRefusal,
  withPin,
  type PinRefusal,
} from "../src/pin/pin.ts";

const FIXTURES = new URL("./fixtures/pin/", import.meta.url);

const VERDICTS = {
  pin: "Pin",
  "no-line": "NoLine",
  malformed: "Malformed",
  duplicated: "Duplicated",
  empty: "Empty",
  short: "Short",
} as const satisfies Record<string, "Pin" | PinRefusal["_tag"]>;

type Verdict = keyof typeof VERDICTS;

const cases = (Object.keys(VERDICTS) as ReadonlyArray<Verdict>).flatMap((verdict) =>
  readdirSync(new URL(`${verdict}/`, FIXTURES)).map((file) => ({
    verdict,
    file,
    text: readFileSync(new URL(`${verdict}/${file}`, FIXTURES), "utf8"),
  })),
);

const SHA = readFileSync(new URL("sha", FIXTURES), "utf8").trim();

const tagOf = (text: string): string =>
  Either.match(pinIn(text), { onLeft: (refusal) => refusal._tag, onRight: () => "Pin" });

const refusalOf = (text: string): PinRefusal =>
  Either.getOrThrowWith(Either.flip(pinIn(text)), () => new Error("expected a refusal"));

describe("the pin grammar", () => {
  it("has a fixture for every case the ticket names", () => {
    const named = cases.map(({ verdict, file }) => `${verdict}/${file}`).toSorted();
    expect(named).toEqual([
      "duplicated/two-valid.toml",
      "empty/empty.toml",
      "malformed/indented.toml",
      "malformed/single-quoted.toml",
      "malformed/trailing-comment.toml",
      "no-line/absent.toml",
      "no-line/mentioned.toml",
      "pin/spaces.toml",
      "pin/tabs.toml",
      "short/abbreviated.toml",
      "short/uppercase.toml",
    ]);
    // The tab case exists for BSD `sed`, which reads `\t` in a bracket
    // expression as a letter: it must carry real tabs, not spaces.
    expect(cases.find((c) => c.file === "tabs.toml")?.text).toMatch(/tool-sha\t=\t"/);
  });

  it.each(cases)("$verdict/$file reads as $verdict", ({ verdict, text }) => {
    expect(tagOf(text)).toBe(VERDICTS[verdict]);
  });

  it("returns the full 40-hex SHA exactly as written", () => {
    expect(SHA).toMatch(/^[0-9a-f]{40}$/);
    for (const { text } of cases.filter((c) => c.verdict === "pin")) {
      expect(pinIn(text)).toEqual(Either.right(SHA));
    }
  });

  // A malformed line wins: with a good line beside it the shim cannot know
  // which one the adopter meant.
  it("refuses a malformed line even beside a valid one", () => {
    const text = `tool-sha = "${SHA}"\ntool-sha = '${SHA}'\n`;
    expect(refusalOf(text)).toMatchObject({ _tag: "Malformed", index: 1 });
  });

  it("refuses a CRLF line as the shim's sed does", () => {
    expect(tagOf(`tool-sha = "${SHA}"\r\n`)).toBe("Malformed");
  });

  it("carries what each refusal needs its sentence to say", () => {
    expect(refusalOf(`a = 1\ntool-sha = "abc1234"\n`)).toMatchObject({
      _tag: "Short",
      index: 1,
      value: "abc1234",
    });
    expect(refusalOf(`tool-sha = "${SHA}"\nx = 1\ntool-sha = ""\n`)).toMatchObject({
      _tag: "Duplicated",
      indices: [0, 2],
    });
  });
});

describe("the rendered refusal", () => {
  const TAGS =
    "`gh api --paginate repos/HireAnEsquire/speepobox/tags " +
    `--jq '.[] | "\\(.commit.sha) \\(.name)"'\``;

  it.each(["empty", "short"] as const)(
    "names the gh api tag list before `upgrade --to vN` from a hand clone for %s",
    (verdict) => {
      for (const { text } of cases.filter((c) => c.verdict === verdict)) {
        const sentence = renderPinRefusal(refusalOf(text));
        expect(RELEASE_URL).toBe("https://github.com/HireAnEsquire/speepobox.git");
        expect(sentence).toContain(TAGS);
        expect(sentence).not.toContain("^{}");
        expect(sentence).toMatch(/upgrade --to vN` from a hand clone/);
        expect(sentence.indexOf(TAGS)).toBeLessThan(sentence.indexOf("upgrade --to vN"));
      }
    },
  );

  it("names each other refusal's own fix", () => {
    const sentenceFor = (verdict: Verdict): string =>
      renderPinRefusal(refusalOf(cases.find((c) => c.verdict === verdict)!.text));
    expect(sentenceFor("no-line")).toMatch(/run `init`.*or add the line/);
    expect(sentenceFor("malformed")).toContain('`tool-sha = "<40-hex sha>"`');
    expect(sentenceFor("duplicated")).toMatch(/keep one$/);
  });
});

describe("the pin line, for `upgrade --to`", () => {
  it.each(cases.filter((c) => ["pin", "empty", "short"].includes(c.verdict)))(
    "finds the one matching line in $verdict/$file whatever its value",
    ({ text }) => {
      const found = Either.getOrThrow(pinLineIn(text));
      expect(text.split("\n")[found.index]).toMatch(/^tool-sha[ \t]*=/);
      expect(text.split("\n")[found.index]).toContain(`"${found.value}"`);
    },
  );

  it.each(cases.filter((c) => ["malformed", "duplicated", "no-line"].includes(c.verdict)))(
    "refuses $verdict/$file: nothing safe to rewrite",
    ({ verdict, text }) => {
      expect(Either.flip(pinLineIn(text))).toMatchObject(Either.right({ _tag: VERDICTS[verdict] }));
    },
  );
});

describe("withPin", () => {
  it("rewrites the located line and no other byte", () => {
    const text = 'base = "main"\r\ntool-sha  =  ""\n# tool-sha = "x"\r\n';
    const located = Either.getOrThrow(pinLineIn(text));
    expect(withPin(text, located.index, SHA)).toBe(
      `base = "main"\r\ntool-sha = "${SHA}"\n# tool-sha = "x"\r\n`,
    );
  });

  it("keeps a file with no trailing newline without one", () => {
    expect(withPin('tool-sha = "abc"', 0, SHA)).toBe(`tool-sha = "${SHA}"`);
  });
});
