# The labels rivi-bot adds, in describe, triage and housekeeping, from the names Claude answers
# with. Each action loads this file with `jq -L "$GITHUB_ACTION_PATH/.."` and `include "labels";`.
#
# Claude's answer is shaped by text anyone can write, so a name is added only when the repository
# has it, spelled exactly as there; it is not on already; and no pattern in the deny list matches
# it. The deny list keeps out the labels a maintainer sets, such as one that starts a coding agent.
# A pattern is a label name, with * for any run of characters, and matches whatever the case.
# rivi-bot's own labels (rivi-bot:*) are never added, whatever the list says: rivi-bot:review
# approves reviews.

# The deny list from an action input, one pattern a line; blank lines are left out.
def deny_patterns: split("\n") | map(gsub("^\\s+|\\s+$"; "") | select(. != ""));

# Whether $pattern matches the label name that is the input.
def matches($pattern):
  ($pattern | gsub("(?<c>[\\\\^$.|?+()\\[\\]{}])"; "\\\(.c)") | gsub("\\*"; ".*")) as $re
  | test("\\A(?:" + $re + ")\\z"; "i");

# Whether the deny list, or rivi-bot's own prefix, holds back the label name that is the input.
def denied($deny): . as $name | any(($deny + ["rivi-bot:*"])[]; . as $pattern | $name | matches($pattern));

# Claude's names (the input), as those rivi-bot adds and those it holds back for a maintainer. Both
# leave out names the repository does not have ($known) and labels already on ($on).
def labels_to_add($known; $on; $deny):
  [unique[] | select(IN($known[]) and (IN($on[]) | not))]
  | {add: map(select(denied($deny) | not)), held: map(select(denied($deny)))};
