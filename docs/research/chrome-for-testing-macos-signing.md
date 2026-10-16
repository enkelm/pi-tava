# Chrome for Testing macOS signature failure

Historical investigation: the owner subsequently chose to use the existing Chrome installation. This note preserves the failed-install evidence, not a recommendation to install another browser or repeat the installer.

## Finding (2026-10-16)

The human-run installer downloaded the selected package but stopped at code-signature verification. **Neither the cause nor the artifact's safety is established.** This is not evidence of a mere Gatekeeper popup, deliberate lack of notarization, or a supported installation workaround. No runtime readiness follows from this investigation.

## Local evidence

Read in full: `/tmp/pi-coop-install-chrome-testing.sh` and `/tmp/pi-coop-chrome-install.log`.

- The log reports **Stable 155.0.8059.84 (`mac-arm64`)**, completion of the manifest transfer, and a completed **183M** archive transfer.
- The script fetches `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json`, selects `channels.Stable`, and validates the selected archive URL against `https://storage.googleapis.com/chrome-for-testing-public/<version>/<platform>/chrome-<platform>.zip`. This validates the selected URL's structure and host, not the archive's cryptographic identity or signing validity. HTTPS redirects are allowed; the log does not record final redirect destinations or an archive digest.
- Extraction is `ditto -x -k "$work/chrome.zip" "$work/unpacked"`. With `set -e`, reaching the subsequent check indicates extraction returned success and the expected browser executable passed `-x`; it does not establish that every bundle resource was extracted correctly.
- The script runs `codesign --verify --deep --strict "$app"`. The log ends with:

    ```text
    /var/folders/5s/cj8c9_rd501491vf3zjk04l40000gn/T//pi-coop-cft.nKFF5F/unpacked/chrome-mac-arm64/Google Chrome for Testing.app: code has no resources but signature indicates they must be present
    ```

- Given this error, the script's fail-fast control flow stops before `spctl --assess --type execute --verbose=2`, destination-directory creation, and copying the app to `~/Applications`. There is no browser-launch, personal-profile-edit, default-browser-change, or server-restart command in the script. These conclusions concern this script run, not unrelated activity on the machine.
- An EXIT trap removes the temporary workspace. The log does not document cleanup success. A subsequent read-only existence check in this Pull thread found both the logged temporary workspace and `~/Applications/Google Chrome for Testing.app` absent; the downloaded archive and extracted bundle are not available there for inspection.

## Signature verification is not a notarization result

Locally installed Apple manual sources (read-only; no verification or assessment was rerun):

- `/usr/share/man/man1/codesign.1`, `--verify`, `--deep`, and `--strict`: verification checks code signatures; deep verification recursively verifies nested code content; strict adds validation restrictions. The reported diagnostic concerns resources expected by the signature. It does not identify which resource/signing component is responsible, or whether the problem originated in Google's archive, extraction, or another bundle/signature mismatch.
- The same manual, `--check-notarization`, describes forcing an online check for an available notarization ticket. The script does not use that option. Its resource-verification error does not establish notarization status.
- `/usr/share/man/man8/spctl.8`, DESCRIPTION, `--assess`, and `--type`: security assessment evaluates policy governing operations such as execution. The script's execution-policy assessment was not reached; no Gatekeeper approval or denial was obtained.
- `/usr/share/man/man1/ditto.1`, `-x` and `-k`: these options extract a PKZip archive. This documents the local tool's operation, not Google's supported release-specific extraction procedure or proof that extraction preserved this particular signed bundle correctly.

A malformed/incompletely signed artifact, an extraction/layout/resource problem, and deliberately unnotarized packaging are distinct possibilities/questions, not interchangeable diagnoses. No available evidence selects a cause, and lack of notarization alone must not be asserted as an explanation for this signature-resource diagnostic.

## External primary-source blocker

This Pull thread attempted permitted `gh issue list` searches explicitly scoped with `--repo GoogleChromeLabs/chrome-for-testing` for the exact error, version `155.0.8059.84`, and `notarized`. The first two calls were rejected without readable error details in the batched output. The distinct `notarized` query returned **401 Unauthorized**, with GitHub's message `Requires authentication`. No request was retried and no alternative network route was used. **Official maintainer issue contents were not obtained.** No Google release-specific signing, notarization, or extraction claim is verified here. The intended primary source is [GoogleChromeLabs/chrome-for-testing issues](https://github.com/GoogleChromeLabs/chrome-for-testing/issues); its contents were not read.

Unresolved questions for an authorized official-source inquiry:

1. Is this exact Stable Apple Silicon archive expected to contain a fully verifiable app signature, and is it notarized?
2. Do maintainers acknowledge this exact resource diagnostic or a packaging defect for this release?
3. What extraction/installation procedure does Google support for this artifact, and is there evidence that procedure addresses the observed error without bypassing verification?
4. Is an authenticated corrected artifact or official resolution available?

## Safe next action

**Do not rerun the installer, launch/install the app, remove quarantine, ad-hoc re-sign it, or skip checks.** Preserve the script and log. The next useful step is obtaining Google's official release/maintainer evidence through an authorized source once available, or a human reporting the version, architecture, command, and diagnostic to the official project. Do not invent a package-manager cask/tap or recommend another installation method as a verified fix. Any subsequent installation or diagnostic download needs separate authorization; browser compatibility/runtime checks remain unresolved independently of signing.

Only this research note was written. SHA-256 checks before and after the helper's audit confirmed the five existing dirty implementation/test/documentation files were unchanged. HEAD remains `176daea1e61438f82113bf8fb1ca43498802bb8e`; the note is an additional untracked file. No install, download, browser launch, security-setting change, runtime check, commit, or restart was performed during this Pull investigation. External reads failed as documented above.
