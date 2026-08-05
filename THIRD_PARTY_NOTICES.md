# Third-Party Notices

OpenMozi's own source code is licensed under the MIT License. Third-party
packages and assets remain subject to their respective licenses.

## CodeSandbox Nodebox

OpenMozi's optional interactive React artifact preview uses
`@codesandbox/sandpack-react`, which includes `@codesandbox/nodebox`.
CodeSandbox Nodebox is licensed under the Sustainable Use License Version 1.0,
not MIT. Its terms restrict commercial use and distribution.

The complete license text is distributed at
[`third_party/licenses/codesandbox-nodebox-SUL-1.0.txt`](third_party/licenses/codesandbox-nodebox-SUL-1.0.txt)
and is included in the packaged macOS application under
`Contents/Resources/licenses/third-party/`.

Before commercially distributing OpenMozi with the interactive React preview,
obtain appropriate permission from CodeSandbox or replace/disable the Nodebox
dependency. This notice does not modify the license terms of any dependency.

## Managed Python document runtime

The packaged macOS application includes a redistributable CPython runtime from
Astral's `python-build-standalone` project plus the document-processing Python
packages pinned in `requirements/document-runtime.txt`. Their upstream license
files are retained inside `Contents/Resources/python/`. The runtime archive is
checksum-pinned during packaging; package licenses remain governed by their
respective upstream terms.

## Lobe UI Markdown typography

The final-answer and Markdown-document typography rules include a Tailwind
transcription of the Markdown styles from `@lobehub/ui` version 5.15.5,
copyright LobeHub. Lobe UI is licensed under the MIT License.

The complete license text is distributed at
[`third_party/licenses/lobehub-ui-MIT.txt`](third_party/licenses/lobehub-ui-MIT.txt).
MOZI retains its own ReactMarkdown renderer and does not bundle the Lobe UI
package solely for these styles.

## Flyfish PPTX viewer

OpenMozi's browser-native PowerPoint preview uses `@file-viewer/pptx` version
2.2.3, copyright 2026 Flyfish Viewer. It is licensed under the Apache License
2.0. The viewer runs locally in the browser and does not upload presentations
to a remote conversion service.

The complete license text is distributed at
[`third_party/licenses/file-viewer-pptx-Apache-2.0.txt`](third_party/licenses/file-viewer-pptx-Apache-2.0.txt)
and is included in the packaged macOS application under
`Contents/Resources/licenses/third-party/`.

## Thinking Orbs activity animations

The animated activity indicators in the web UI (thinking, working, searching
states) use the `thinking-orbs` package version 0.2.0, copyright 2026 Jakub
Antalik. It is licensed under the MIT License. The orbs render locally on a
2D canvas with no network access.

The complete license text is distributed at
[`third_party/licenses/thinking-orbs-MIT.txt`](third_party/licenses/thinking-orbs-MIT.txt).

## Other dependencies

Dependency manifests and the lockfile identify the remaining third-party
packages. Their copyright and license notices are preserved in source and
packaged distributions where required. Run a dependency-license review before
each public release because transitive dependencies can change.
