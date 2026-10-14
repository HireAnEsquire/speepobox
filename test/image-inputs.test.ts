import { describe, expect, it } from "@effect/vitest";
import { Either } from "effect";
import { type InputsListRefused, parseInputsList } from "../src/image/inputs.ts";

const DOCKERFILE = ".bessemer/image/Dockerfile";

const refusal = (text: string): InputsListRefused => {
  const parsed = parseInputsList(text, DOCKERFILE);
  if (Either.isRight(parsed)) {
    throw new Error(`expected a refusal, got ${parsed.right.join(", ")}`);
  }
  return parsed.left;
};

describe("parseInputsList", () => {
  it("puts the Dockerfile first, then the listed paths in file order", () => {
    const list = [
      "# bessemer template v1",
      "",
      "  client/yarn.lock  ",
      "\t# indented comment",
      "api/requirements.txt",
      "",
    ].join("\n");
    expect(parseInputsList(list, DOCKERFILE)).toEqual(
      Either.right([DOCKERFILE, "client/yarn.lock", "api/requirements.txt"]),
    );
  });

  it("yields the Dockerfile alone for an empty or comment-only list", () => {
    expect(parseInputsList("", DOCKERFILE)).toEqual(Either.right([DOCKERFILE]));
    expect(parseInputsList("# nothing yet\n\n#\n", DOCKERFILE)).toEqual(Either.right([DOCKERFILE]));
  });

  it("drops a listed Dockerfile rather than hashing it twice", () => {
    expect(parseInputsList(`a.txt\n${DOCKERFILE}\n./${DOCKERFILE}\nb.txt`, DOCKERFILE)).toEqual(
      Either.right([DOCKERFILE, "a.txt", "b.txt"]),
    );
  });

  it.each(["api/requirements*.txt", "a?.txt", "lib/[ab].txt"])("refuses the glob %s", (glob) => {
    const refused = refusal(`a.txt\n${glob}`);
    expect(refused).toMatchObject({ line: 2, text: glob });
    expect(refused.reason).toContain("glob");
  });

  it("refuses an absolute path, naming the line", () => {
    expect(refusal("\n/etc/passwd")).toMatchObject({ line: 2, text: "/etc/passwd" });
  });

  it.each(["../outside.txt", "a/../../outside.txt", ".."])(
    "refuses %s, which leaves the repo",
    (escaping) => {
      expect(refusal(`# c\n${escaping}`)).toMatchObject({ line: 2, text: escaping });
    },
  );

  it.each([".", "./", "a/.."])("refuses %s, which names the repo root", (root) => {
    expect(refusal(`a.txt\n${root}`)).toMatchObject({ line: 2, text: root });
  });

  it("keeps a `..` that stays inside the repo, normalized", () => {
    expect(parseInputsList("a/../b.txt", DOCKERFILE)).toEqual(Either.right([DOCKERFILE, "b.txt"]));
  });

  it("refuses a repeated path, naming the repeat", () => {
    const refused = refusal("a.txt\nb.txt\n./a.txt");
    expect(refused).toMatchObject({ line: 3, text: "./a.txt" });
    expect(refused.reason).toContain("twice");
  });
});
