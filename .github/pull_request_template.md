## Summary

Describe the user-visible problem and the fix.

## Compatibility

- [ ] Tested on DSH 0.2.1-rc.2 or a documented alternate version
- [ ] No `ctx.compaction` registration or backend replacement added
- [ ] Tool names remain under the `sumidx_` namespace
- [ ] No direct `session.append()` except through an approved host channel
- [ ] Config defaults and `dsh-plugin.naming.json` remain consistent

## Tests

- [ ] `npm test`
- [ ] `npm run check`
- [ ] Added a regression test for the bug
- [ ] Removed credentials and private session data from fixtures/logs

## Notes

Mention borrowed ideas separately from code actually implemented here.
