import { packager } from '@electron/packager';

const paths = await packager({
  dir: '.',
  name: 'YiddishVoice',
  platform: 'win32',
  arch: 'x64',
  out: './dist',
  overwrite: true,
  ignore: [
    /runpod-workers/,
    /\.a5c/,
    /credentials/,
    /dist/,
    /setup-vertex-auth/,
    /deploy-pod/,
    /vertex-service-account\.json/,
    /build\.mjs/,
    /\.output/,
    /start\.bat/,
    /\.gitignore/,
    /\.env/,
  ],
});

console.log('SUCCESS! Packaged to:', paths);
