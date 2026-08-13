# Third-Party Notices

This file is an inventory, not a replacement for the license texts distributed by each dependency.

| Component | Version | Source | Declared license | Distribution |
| --- | --- | --- | --- | --- |
| `@trycourier/courier` | 7.25.0 | npm | Apache-2.0 | Installed by npm |
| `@voicecan/contracts` | 0.1.0-preview.1 | reviewed local artifact | Apache-2.0 | Vendored tarball |
| `@voicecan/server-client` | 0.1.0-preview.1 | reviewed local artifact | Apache-2.0 | Vendored tarball |
| `Systran/faster-whisper-small` | pinned revision `536b066…` | Hugging Face | MIT | Downloaded during Local Full setup |
| `Qwen/Qwen3-4B-GGUF` | pinned revision `34778e2…` | Hugging Face | Apache-2.0 | Downloaded during Local Full setup |

The VoiceCan SDK tarballs are distributed under Apache-2.0, include their license text, and are integrity-pinned by `studio/vendor/sdk-artifacts.sha256`.

Transitive dependency licenses must be regenerated and reviewed as part of each release. Local Full also downloads model and binary artifacts during setup; their upstream license texts and redistribution conditions remain applicable even when the files are not committed here. Model license metadata was checked against the upstream [Faster-Whisper model card](https://huggingface.co/Systran/faster-whisper-small) and [Qwen3 GGUF model card](https://huggingface.co/Qwen/Qwen3-4B-GGUF); re-check the pinned revisions before release.
