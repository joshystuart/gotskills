If you have no tool to run commands, don't write commands or pretend to run them. Judge from the plan, diff and checks output given here, and reply with the JSON the instructions ask for.

The checks run on Linux. `app/scripts/releaseWorkflow.test.ts` is left out of them because the release workflow's `sed -i ''` only works on macOS. That is in the base commit and is not part of this build: do not report it.

Use these severities:

- **critical:** the app loses or damages a user's files, or the build does not compile.
- **major:** a user-visible behaviour the plan asks for is wrong or missing, or the app reports success for something that failed.
- **minor:** an edge case the plan does not spell out, or a test that would miss a regression.
- **nit:** style or naming only.
