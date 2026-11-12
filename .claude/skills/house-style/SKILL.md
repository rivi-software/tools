---
name: house-style
description: The house style for prose in rivi-software/tools. Use before writing or editing anything people read here, such as a README, an issue, a pull request description, a changeset, release notes, a doc comment or a commit message.
---

# House style

Everything written in this repository reads alike: `CONTRIBUTING.md`, the package READMEs, the changesets in `packages/*/CHANGELOG.md`, the issues. Match it. When in doubt, read a page of `CONTRIBUTING.md` and write like that.

## Sentences

- Short, declarative sentences in the present tense. One fact per sentence, one fact per bullet. A bullet is a full sentence and ends with a period.
- The subject is the code or the change: "The Worker now sends…", "A tab reads `/build.json`…". The writer stays out of it, with no "I". A document can address its reader as "you".
- Plain verbs and nouns carry the meaning: says, runs, checks, sends, a fix, a test. A word whose only job is emphasis or reassurance comes out.
- Clauses join with a colon, a comma or a full stop. The repository has no em dashes.
- Examples follow "such as".
- "pull request" is spelled out, in titles too.

## Content

- Write for the person who reads that document: the people who use a package (README, changeset, release notes), a reviewer (pull request), a maintainer who acts on it (issue). Lead with what they notice or have to do, then the mechanism.
- Be concrete. Name the file, the function, the option, the version, and in an issue the `path:line`. Show the smallest example in backticks rather than describe it.
- Old behaviour comes after the new, as "Before, …".
- Claim only what was checked this session. A command that was not run, or a page that was not read, is not described as passing or as saying something.
- Link the source (a doc, an issue, a pull request, a permalink) rather than restate it.

## Formatting

- Code, paths, commands, package names, labels and options go in backticks.
- Headings are in sentence case.
- A paragraph is one line in Markdown files: Oxfmt leaves Markdown alone, and the existing files are not hard-wrapped.

## A public repository

Everything written here is public, and stays cached after a delete.

- Secrets, tokens, private repository names, customer data and internal incidents stay out: of text, code, fixtures and commit messages alike.
- An `@mention` notifies a real person. Write one only for a handle checked this session (`gh api user`, `gh pr view --json author`), never one inferred from a display name.
