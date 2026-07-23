# B0 Sandbox Spike - Native macOS App Sandbox + Child Node Backend

Last checked: 2026-07-04.

Scope: de-risk Track B0 from [0002-native-app-file-model.md](./0002-native-app-file-model.md)
before production Swift is written.

Hard honesty boundary: this spike did not create a signed/notarized `.app` bundle
and did not run Node as a true App-Sandboxed child of that bundle. This machine
has no usable Developer ID signing identity. The local native-module test is an
ad-hoc signing and dynamic-loading approximation only.

## Environment

VERIFIED-LOCALLY, confidence high:

```text
Command: sw_vers; uname -m; xcodebuild -version
Observed:
ProductName: macOS
ProductVersion: 26.5.1
BuildVersion: 25F80
arm64
Xcode 26.6
Build version 17F113
```

```text
Command: security find-identity -v -p codesigning
Observed:
0 valid identities found
```

```text
Command: /opt/homebrew/opt/node@22/bin/node -p "JSON.stringify({node:process.version, modules:process.versions.modules, platform:process.platform, arch:process.arch, napi:process.versions.napi})"
Observed:
{"node":"v22.23.1","modules":"127","platform":"darwin","arch":"arm64","napi":"10"}
```

```text
Command: /opt/homebrew/bin/node -p "JSON.stringify({node:process.version, modules:process.versions.modules, platform:process.platform, arch:process.arch, napi:process.versions.napi})"
Observed:
{"node":"v26.0.0","modules":"147","platform":"darwin","arch":"arm64","napi":"10"}
```

## 1. Entitlements

Status: RESEARCHED, confidence high for keys and purposes, medium for whether
`network.server` is required for loopback until tested in a signed sandboxed
app.

Apple's entitlement reference says App Sandbox is enabled per target, then
capabilities are restored by entitlement. It also says entitlement values are
incorporated into the code signature at build time.

| Key | Target | Purpose for MOZI | Required? | Source |
| --- | --- | --- | --- | --- |
| `com.apple.security.app-sandbox` | Main Swift app | Enables App Sandbox. Without this, the other App Sandbox entitlements are meaningless. | Yes | Apple Entitlement Key Reference, "Enabling App Sandbox", app-sandbox row and enable setting. |
| `com.apple.security.files.user-selected.read-write` | Main Swift app | Allows read/write access to files and folders explicitly selected through `NSOpenPanel`/`NSSavePanel`. This is the folder-grant UX base. | Yes | Apple Entitlement Key Reference, user-selected read/write rows and "Enabling User-Selected File Access". |
| `com.apple.security.files.bookmarks.app-scope` | Main Swift app | Allows app-scoped security-scoped bookmarks and URLs so selected folders can persist across restarts. | Yes | Apple Entitlement Key Reference, bookmarks app-scope row and "Enabling Security-Scoped Bookmark and URL Access". |
| `com.apple.security.network.client` | Main Swift app, inherited by child | Allows outbound network sockets. Needed for LLM/API calls and any client connection from the app/child to same-machine or remote servers. | Yes, because operator chose network-on | Apple Entitlement Key Reference, network client row and network access section. |
| `com.apple.security.network.server` | Main Swift app, inherited by child | Allows listening sockets. Likely needed if the Node child serves Fastify on `127.0.0.1:9210` for `WKWebView`. | Likely yes unless B1 removes the local HTTP listener | Apple Entitlement Key Reference, network server row and network access section. Apple distinguishes outgoing client sockets from incoming sockets. |
| `com.apple.security.inherit` | Child executable target only, not main app | Allows a child process created with `posix_spawn`/`NSTask` to inherit the parent's App Sandbox. Apple says the child target must use exactly `app-sandbox` plus `inherit`; other App Sandbox entitlements on the child abort it. | Yes for a signed bundled Node helper | Apple Entitlement Key Reference, "Enabling App Sandbox Inheritance". |
| `com.apple.security.files.user-selected.executable` | Main app only if MOZI writes executable files into selected folders | Avoids quarantine problems for executable files written by a sandboxed app. This is not a general "spawn shell" entitlement and is not needed for a bundled signed Node binary. | Optional, avoid unless needed | Apple Entitlement Key Reference, executable user-selected note. |
| `com.apple.security.application-groups` | Only if using a separate app/helper group | Shared group container and some IPC among apps from the same team. Not needed for a direct child. May be useful if the bookmark/file broker becomes a separate helper outside the main app bundle boundary. | Optional | Apple Entitlement Key Reference, application-groups section. |

Important interpretation:

- There is no entitlement that grants "run arbitrary shell unsandboxed".
  `NSTask`/`posix_spawn` children inherit confinement.
- The main app must not set `com.apple.security.inherit`.
- The bundled Node child should be signed as its own executable with only:

```xml
<key>com.apple.security.app-sandbox</key>
<true/>
<key>com.apple.security.inherit</key>
<true/>
```

- Native `.node` files are loadable Mach-O code and must be signed, but should
  not receive the child-process App Sandbox inheritance entitlement unless Apple
  tooling for the final bundle proves otherwise. Sign nested libraries/addons
  explicitly before signing the app bundle.

## 2. Child-Process Sandbox Inheritance

Status: RESEARCHED, confidence high for generic inheritance and Apple App
Sandbox child-target rules; confidence medium for real Node/shell behavior until
tested inside a signed `.app`.

VERIFIED-LOCALLY, source is the local Apple man page:

```text
Command: man sandbox | col -b | sed -n '1,40p'
Observed:
The sandbox facility allows applications to voluntarily restrict their
access to operating system resources...

New processes inherit the sandbox of their parent. Restrictions are
generally enforced upon acquisition of operating system resources only.
```

RESEARCHED from Apple Entitlement Key Reference:

- A child process created with `posix_spawn` or `NSTask` can be configured to
  inherit the parent's sandbox.
- XPC is Apple's preferred technology for privilege separation.
- A child target using inheritance must use exactly `com.apple.security.app-sandbox`
  and `com.apple.security.inherit`.
- Static inheritance does not include PowerBox rights added after launch, such
  as user-selected file access. Apple says to pass data or a bookmark to the
  child for files opened after launch.

Likely friction for a Node child running shell tools:

- `/bin/sh`, `/usr/bin/python3`, `/usr/bin/git`, Homebrew tools, and spawned
  grandchildren should inherit the sandbox. This confines them, but it also
  means their normal reads of `$HOME`, dotfiles, credentials, package caches,
  Homebrew prefixes, and project paths can be denied.
- Terminal-only or user-session operations such as opening Terminal, AppleScript
  automation, Accessibility, clipboard/UI scripting, and TCC-protected data are
  not covered by these entitlements and should be expected to fail or require
  separate user grants.
- Temp behavior must be tested. `FileManager.default.temporaryDirectory` and
  Node `os.tmpdir()` should be preferred over hardcoded `/tmp`/`/private/tmp`.
- Executing tools from `/usr/bin` may work, but tools that load plugins,
  config, compilers, SDKs, SSH keys, or Homebrew dylibs outside the app
  container can fail under sandbox restrictions.
- The local HTTP server design probably needs `network.server`; outbound LLM
  calls need `network.client`.

## 3. Native Modules

Status: VERIFIED-LOCALLY for ad-hoc signed Node 22 plus ad-hoc signed copies of
`better_sqlite3.node` and `lancedb.darwin-arm64.node`; confidence high for this
approximation, low for true App Sandbox until signed `.app` testing happens.

Disposable harness:

- `spikes/sandbox-b0/prepare-and-run.sh`
- `spikes/sandbox-b0/native-module-check.mjs`

The harness copies Node 22, `libnode.127.dylib`, `better_sqlite3.node`, and
`lancedb.darwin-arm64.node` into ignored `spikes/sandbox-b0/stage/`, ad-hoc
signs the copies, verifies signatures, then forces the packages to load those
signed addon copies:

- `better-sqlite3`: passes `nativeBinding` pointing at staged
  `better_sqlite3.node`.
- `@lancedb/lancedb`: sets `NAPI_RS_NATIVE_LIBRARY_PATH` pointing at staged
  `lancedb.darwin-arm64.node`.

Command:

```sh
./spikes/sandbox-b0/prepare-and-run.sh 2>&1 | tee spikes/sandbox-b0/native-module-check.log
```

Observed relevant output:

```text
node_source=/opt/homebrew/opt/node@22/bin/node
libnode_source=/opt/homebrew/opt/node@22/lib/libnode.127.dylib
sqlite_native_copy=/Users/example/projects/OpenMozi/spikes/sandbox-b0/stage/native/better_sqlite3.node
lancedb_native_copy=/Users/example/projects/OpenMozi/spikes/sandbox-b0/stage/native/lancedb.darwin-arm64.node

codesign_verify_node:
.../stage/bin/node: valid on disk
.../stage/bin/node: satisfies its Designated Requirement
codesign_verify_libnode:
.../stage/lib/libnode.127.dylib: valid on disk
.../stage/lib/libnode.127.dylib: satisfies its Designated Requirement
codesign_verify_better_sqlite3:
.../stage/native/better_sqlite3.node: valid on disk
.../stage/native/better_sqlite3.node: satisfies its Designated Requirement
codesign_verify_lancedb:
.../stage/native/lancedb.darwin-arm64.node: valid on disk
.../stage/native/lancedb.darwin-arm64.node: satisfies its Designated Requirement

CodeDirectory ... flags=0x2(adhoc) ...
Signature=adhoc
TeamIdentifier=not set

{
  "status": "ok",
  "node": "/Users/example/projects/OpenMozi/spikes/sandbox-b0/stage/bin/node",
  "modules": "127",
  "sqliteNative": "/Users/example/projects/OpenMozi/spikes/sandbox-b0/stage/native/better_sqlite3.node",
  "sqliteRow": {
    "id": 1,
    "label": "signed-native-ok"
  },
  "lanceNative": "/Users/example/projects/OpenMozi/spikes/sandbox-b0/stage/native/lancedb.darwin-arm64.node",
  "lanceTables": [
    "items"
  ],
  "lanceRowCount": 2
}
```

Additional local risk found:

```sh
MOZI_B0_NODE=/opt/homebrew/bin/node ./spikes/sandbox-b0/prepare-and-run.sh
```

Observed failure with Node 26:

```text
Error: The module '.../better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 147.
Node.js v26.0.0
```

Implication: production must ship a pinned Node 22 runtime, or rebuild all
ABI-sensitive native modules for the shipped Node. Do not rely on the operator's
PATH Node.

Packaging friction also surfaced: Homebrew Node 22 is not just one binary. It
loads `@rpath/libnode.127.dylib` and many Homebrew dylibs. A production bundle
must either ship an official self-contained Node distribution or bundle and sign
every non-system dylib dependency after checking `otool -L`.

## 4. Security-Scoped Bookmark Handoff

Status: RESEARCHED, confidence medium. This is not locally verified in a real
sandbox.

Apple sources:

- App-scoped bookmarks require `com.apple.security.files.bookmarks.app-scope`.
- User-selected read/write access is granted through Open/Save panels.
- Security-scoped URLs require `startAccessingSecurityScopedResource()` before
  access and `stopAccessingSecurityScopedResource()` when done.
- For App Sandbox inheritance, Apple explicitly says inherited static rights do
  not include later PowerBox access, and for files opened after launch you must
  pass data or a bookmark to the child.

Conclusion: option (a), "Swift parent calls
`startAccessingSecurityScopedResource()` and then spawns Node with a path", is
not safe to assume. It may fail because dynamic PowerBox rights are not part of
static sandbox inheritance.

Recommended pattern to prove before B1:

1. Swift app uses `NSOpenPanel` with directory selection.
2. Swift app creates an app-scoped security bookmark:

```swift
let bookmark = try url.bookmarkData(
  options: [.withSecurityScope],
  includingResourceValuesForKeys: nil,
  relativeTo: nil
)
```

3. Store bookmark data in the app container, not just the path.
4. Pass bookmark data to the worker boundary, for example base64 over stdin,
   a private local IPC channel, or XPC. Do not pass only the path.
5. The process that performs filesystem I/O must resolve and start access:

```swift
var stale = false
let scopedURL = try URL(
  resolvingBookmarkData: bookmark,
  options: [.withSecurityScope],
  relativeTo: nil,
  bookmarkDataIsStale: &stale
)
let ok = scopedURL.startAccessingSecurityScopedResource()
defer {
  if ok { scopedURL.stopAccessingSecurityScopedResource() }
}
```

6. Node then receives the resolved path as an allowed root only after the native
   side has started scoped access.

Open design issue:

- Pure Node cannot consume Apple's security-scoped bookmarks without a native
  bridge. The likely choices are:
  - a small native N-API/Swift/Objective-C bridge loaded by Node to resolve and
    hold bookmark access for the process;
  - a Swift launcher/helper that owns bookmark access and hosts or supervises
    Node;
  - an XPC service/file broker. Apple recommends XPC for privilege separation,
    but brokering all MOZI filesystem and shell behavior through XPC is a larger
    architecture change.

Acceptance test required with Apple account:

- Pick a folder through `NSOpenPanel`.
- Persist bookmark.
- Restart app.
- Spawn sandboxed Node child.
- Node writes to the picked folder.
- Node is denied outside the picked folder and app container.
- Revoke/delete bookmark and verify the write fails clearly.

## 5. Shell Tools and Office Skills

Status: RESEARCHED for App Sandbox behavior; VERIFIED-LOCALLY for current
Python availability. Confidence medium until real sandbox tests run.

Current local Python facts:

```text
Command: command -v python3; python3 --version
Observed:
/opt/homebrew/bin/python3
Python 3.11.5
```

```text
Command: python3 - <<'PY'
mods=['docx','openpyxl','pptx']
for m in mods:
    try:
        mod=__import__(m)
        print(f'{m}: OK {getattr(mod, "__version__", "unknown")}')
    except Exception as e:
        print(f'{m}: MISSING {type(e).__name__}: {e}')
PY
Observed:
docx: OK 1.1.2
openpyxl: OK 3.1.5
pptx: OK 1.0.0
```

```text
Command: /usr/bin/python3 --version and import docx/openpyxl/pptx
Observed:
Python 3.9.6
docx: MISSING ModuleNotFoundError: No module named 'docx'
openpyxl: MISSING ModuleNotFoundError: No module named 'openpyxl'
pptx: MISSING ModuleNotFoundError: No module named 'pptx'
```

Expected App Sandbox behavior:

| Flow | App container output | User-picked folder |
| --- | --- | --- |
| `docx` using document-generation/editing helpers | Should work if Python/Node and packages are bundled or installed in the app container, and output path resolves inside the sandbox container. | Should work only if the process doing I/O has active scoped access to the bookmark. |
| `xlsx` using `openpyxl` | Same as docx. Formula calculation still needs Excel/LibreOffice if required; opening external apps is separate from App Sandbox file access. | Same bookmark requirement. |
| `pptx` using PPTX helpers and Pillow | Same as docx. Rendering/export through LibreOffice may fail unless LibreOffice is accessible and sandbox-compatible. | Same bookmark requirement. |

Do not rely on `/usr/bin/python3` for office flows. It exists but lacks the
required packages here. Do not rely on the operator's Miniconda path in a
sandboxed production app; it lives outside the app bundle/container and may be
blocked or absent.

Recommended packaging model for office skills:

- Bundle a known Python runtime or self-contained venv under the app bundle or
  initialize it inside the app container on first run.
- Install `python-docx`, `openpyxl`, `python-pptx`, and `Pillow` at packaging
  time, not during arbitrary user tasks.
- Set `PYTHONHOME`, `PYTHONPATH`, `VIRTUAL_ENV`, cache dirs, and temp dirs to
  app-container paths.
- Treat `pip install` inside the sandbox as unsupported by default. It needs
  outbound network, writes to site-packages/cache locations, may build native
  code, and may invoke compilers outside the allowed roots.

The logical `~/.mozi/output` in ADR 0002 should map to the sandboxed app's
container home, not the user's real home directory, unless the user explicitly
grants the real home path. B1 must verify what `HOME`, `NSHomeDirectory()`, and
Node `os.homedir()` are inside the signed app and set MOZI paths explicitly.

## 6. Packaging and Notarization

Status: BLOCKED-NEEDS-APPLE-ACCOUNT, confidence high.

Blocked because this machine has no valid Developer ID signing identity:

```text
Command: security find-identity -v -p codesigning
Observed:
0 valid identities found
```

Operator must provide:

- Apple Developer Program membership.
- A valid `Developer ID Application: <Name> (<TEAMID>)` certificate and private
  key installed in the signing keychain.
- Team ID.
- Notary credentials, either App Store Connect API key (`key`, `key-id`,
  `issuer`) or Apple ID plus app-specific password.
- A real `.app` harness with entitlements, not only copied binaries.

Signed tree requirements:

```text
Mozi.app/
  Contents/
    Info.plist
    MacOS/
      Mozi              # Swift app executable, app entitlements
    Helpers/
      node              # pinned Node 22 helper, child inherit entitlements
    Resources/
      mozi/
        dist/
        package.json
        node_modules/
          ...           # production deps
          better_sqlite3.node
          lancedb.darwin-arm64.node
      python/ or venv/  # if office skills are supported offline
    Frameworks/         # bundled dylibs/frameworks, if any
    XPCServices/        # only if bookmark/file broker uses XPC
```

Before signing, run `otool -L` on:

- `Contents/Helpers/node`
- `libnode.*.dylib`
- every `.node` file
- every bundled `.dylib`/framework

Bundle all non-system runtime dependencies or use a Node distribution that does
not depend on Homebrew paths. Sign nested code explicitly. The local `codesign`
man page says `--deep` signing is deprecated and can apply the wrong options to
nested code; use explicit signing order, then `--deep` for verification.

Representative commands for the operator:

```sh
security find-identity -v -p codesigning

export TEAM_ID="<TEAMID>"
export CERT="Developer ID Application: <Name> ($TEAM_ID)"

# Sign native/loadable code first. Adjust paths to the actual staged tree.
find Mozi.app -type f \( -name "*.node" -o -name "*.dylib" \) -print0 |
  xargs -0 -I{} codesign --force --timestamp --options runtime --sign "$CERT" "{}"

codesign --force --timestamp --options runtime \
  --entitlements entitlements/child-node.entitlements \
  --sign "$CERT" \
  Mozi.app/Contents/Helpers/node

codesign --force --timestamp --options runtime \
  --entitlements entitlements/app.entitlements \
  --sign "$CERT" \
  Mozi.app

codesign --verify --deep --strict --verbose=4 Mozi.app
spctl -a -vvv -t exec Mozi.app

ditto -c -k --keepParent Mozi.app Mozi.zip

xcrun notarytool store-credentials mozi-notary \
  --apple-id "<APPLE_ID>" \
  --team-id "$TEAM_ID" \
  --password "<APP_SPECIFIC_PASSWORD>"

xcrun notarytool submit Mozi.zip \
  --keychain-profile mozi-notary \
  --wait

xcrun stapler staple Mozi.app
xcrun stapler validate Mozi.app
```

Local tool help verified:

- `xcrun notarytool submit --help` supports `--keychain-profile`, API-key
  options, Apple ID/password options, and `--wait`.
- `xcrun stapler` supports `staple` and `validate` for code-signed executable
  bundles, signed flat installer packages, and UDIF disk images.

## Sources

- Apple Entitlement Key Reference, Enabling App Sandbox:
  <https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html>
- Apple Document Picker Programming Guide, security-scoped URL requirements:
  <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/DocumentPickerProgrammingGuide/AccessingDocuments/AccessingDocuments.html>
- Apple `startAccessingSecurityScopedResource()` API page:
  <https://developer.apple.com/documentation/foundation/nsurl/startaccessingsecurityscopedresource()>
- Apple notarization overview:
  <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
- Local Apple man pages and Xcode tools on this machine:
  `man sandbox`, `man sandbox-exec`, `man codesign`,
  `xcrun notarytool --help`, `xcrun stapler`.

## Verdict

GO-WITH-RISKS for the native App Sandbox model as a direction.

NO-GO for starting B1 production Swift until the account-backed B0 proofs below
pass. The architecture is plausible and the native modules loaded under
ad-hoc-signed Node 22, but the security-scoped bookmark handoff, real sandboxed
shell behavior, local server entitlements, and notarization are not yet proven.

Prioritized proofs before B1:

1. Build a minimal signed `.app` with App Sandbox entitlements that spawns a
   signed Node 22 child with `app-sandbox` + `inherit`; prove Node, SQLite, and
   LanceDB work inside the app container.
2. Prove folder grant handoff end to end: `NSOpenPanel` -> app-scoped bookmark
   -> restart -> sandboxed Node child writes inside granted folder and is denied
   outside it.
3. Decide and prove the bookmark consumer design: native Node bridge, Swift
   launcher/helper, or XPC broker. Do not assume parent-only
   `startAccessingSecurityScopedResource()` is enough.
4. Prove `python3` office flows with the intended packaged Python/venv write to
   app-container output and to a bookmarked folder. Do not rely on system Python
   or user Miniconda.
5. Prove `network.client` and likely `network.server` are sufficient for
   `WKWebView -> 127.0.0.1:9210` plus outbound provider calls.
6. Sign and notarize the full tree with the operator's Developer ID identity,
   including every `.node`, `.dylib`, helper, XPC service, and app executable.

Fallback triggers:

- If the sandboxed Node child cannot reliably consume security-scoped bookmarks
  without a large native bridge, use the Electron-interim path from ADR 0002:
  ship Track A file-model and folder-grant UX honestly as code-level policy,
  without claiming OS sandbox.
- If shell/office flows cannot run inside App Sandbox with bundled runtimes and
  acceptable restrictions, reconsider ADR 0001 Docker per-tool sandbox for those
  flows.
- If notarization rejects the Node/native-module tree or requires brittle
  signing exceptions, pause native Track B and continue with Electron-interim or
  Docker per-tool isolation until the signing model is stable.
