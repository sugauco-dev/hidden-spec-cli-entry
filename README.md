# mend

![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sugauco-dev/hidden-spec-cli-entry/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sugauco-dev/hidden-spec-cli-entry/reward.svg)

mend applies an edit that an AI model wrote to a tree of text files, reading it in any of four formats:
unified diff, SEARCH/REPLACE blocks, the V4A patch format, and JSON text-editor edits, all exactly as
[SPEC.md](SPEC.md) specifies. Every file is changed or nothing is. Run it as `node main.ts [options] [PATCH]`
from the root of the tree; entered in the [make.fun](https://make.fun) bounty
hidden-spec-cli-01-run-20261122.
