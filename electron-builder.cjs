const pkg = require('./package.json');
const signed = process.env.QSA_SIGNED_BUILD === '1';
if (!pkg.version.includes('-') && !signed) throw new Error('正式版本必须使用签名构建；无签名包请使用 beta 版本号。');

module.exports = {
  appId: 'com.jaqenhu.qsa-rag',
  productName: 'QSA-RAG',
  copyright: 'QSA-RAG contributors',
  asar: true,
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  forceCodeSigning: signed,
  directories: { output: 'release', buildResources: 'desktop' },
  files: [
    'package.json', 'server.mjs', '*.js', 'index.html', 'styles.css', 'favicon.svg',
    'backend/*.mjs', 'assets/**/*', 'desktop/*.mjs', 'desktop/icon.png',
    '!**/__pycache__/**', '!**/*.pyc',
  ],
  extraResources: [
    { from: '.build/python-win-x64', to: 'python', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
    { from: 'backend', to: 'python-scripts', filter: ['*.py'] },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop/icon.ico', verifyUpdateCodeSignature: signed },
  nsis: {
    oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true, shortcutName: 'QSA-RAG', deleteAppDataOnUninstall: false,
    artifactName: 'QSA-RAG-${version}-win-${arch}-setup.${ext}', differentialPackage: true,
  },
  publish: [{ provider: 'github', owner: 'jaqenhu', repo: 'QSA-RAG', channel: pkg.version.includes('-') ? 'beta' : 'latest', releaseType: 'draft' }],
  generateUpdatesFilesForAllChannels: true,
};
