# Excel fixtures

No `.xlsx` files are checked in here on purpose.

The stale-answer test workbook (an exported Answers sheet whose `questionRevision` no longer matches the
question) is produced by the tests themselves: they export a real workbook from `fixtures/data`,
edit it, bump the question revision, and re-import it to check that the stale row is rejected.

Questions in `fixtures/data/projects/harborlight` with `questionRevision: 2` (for example `HBL-Q-005`)
let tests write a workbook row that claims revision 1 and observe the conflict.
