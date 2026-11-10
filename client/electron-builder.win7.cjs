const { build } = require("./package.json");

// Share application code, but keep the runtime, installer identity and output separate.
module.exports = {
  ...build,
  extends: null,
  electronVersion: "22.3.27",
  appId: "com.quantitative.desktop.win7",
  productName: "Meeting Assistant",
  extraMetadata: { ...build.extraMetadata, productName: "Meeting Assistant" },
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
    artifactName: "meeting-assistant-${version}-win7-${arch}-${target}.${ext}",
  },
  nsis: {
    ...build.nsis,
    artifactName: "meeting-assistant-${version}-win7-${arch}-setup.${ext}",
  },
  portable: {
    ...build.portable,
    artifactName: "meeting-assistant-${version}-win7-${arch}-portable.${ext}",
  },
};
