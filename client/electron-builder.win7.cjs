const { build } = require("./package.json");

// Share application code, but keep the runtime, installer identity and output separate.
module.exports = {
  ...build,
  extends: null,
  electronVersion: "22.3.27",
  appId: "com.meetingfloat.desktop.win7",
  productName: "Meeting Float Desktop Win7",
  extraMetadata: { ...build.extraMetadata, productName: "Meeting Float Desktop Win7" },
  directories: { output: "release/win7" },
  files: [
    { from: "dist-win7", to: "dist" },
    "electron/**/*",
    "assets/**/*",
    "package.json",
  ],
  win: {
    ...build.win,
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
    artifactName: "meeting-float-desktop-${version}-win7-${arch}-${target}.${ext}",
  },
  nsis: {
    ...build.nsis,
    artifactName: "meeting-float-desktop-${version}-win7-${arch}-setup.${ext}",
  },
  portable: {
    ...build.portable,
    artifactName: "meeting-float-desktop-${version}-win7-${arch}-portable.${ext}",
  },
};
