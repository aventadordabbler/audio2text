# Fluent microphone icon

Downloaded from Microsoft Fluent UI System Icons for the meeting recording client.

- Author: Microsoft Corporation
- Icon: `ic_fluent_mic_48_color.svg`
- Source: https://github.com/microsoft/fluentui-system-icons/blob/9cf8af0f95a555918a60b8147a2f33a6a1248442/assets/Mic/SVG/ic_fluent_mic_48_color.svg
- Revision: `9cf8af0f95a555918a60b8147a2f33a6a1248442`
- Downloaded: 2026-09-17
- License: MIT; the original copyright and license text are included in `LICENSE`.

Files:

- `icon.svg`: unmodified upstream vector source.
- `icon.png`: 1024 × 1024 PNG with transparency, rendered from the SVG.
- `icon.ico`: Windows icon containing 16, 32, 48, 64, 128, and 256 px images.

PNG and ICO files were generated locally using the client's existing `sharp` and
`png-to-ico` dependencies. Retain `LICENSE` when distributing these files.

The client uses `icon.svg` as its application icon source. Run `npm run icons`
from `client/` to generate `assets/icon.png` and `assets/icon.ico`; both standard
and Win7 builds run this automatically before compiling the renderer.

The generated PNG is used by the application windows and tray. The generated ICO
is embedded in the Windows application, installer, and uninstaller for both
editions. This directory, including `LICENSE`, is included in the packaged app.
