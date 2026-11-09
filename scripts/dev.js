// Development server: separate data folder so real company data is never touched.
// Usage: node scripts/dev.js   (then: npm run demo, to load the demo company)
import path from 'node:path';
import os from 'node:os';

process.env.DATA_DIR ||= path.join(process.env.LOCALAPPDATA || os.homedir(), 'JoineryPricing-dev');
process.env.PORT ||= '4320';
const { start } = await import('../server/index.js');
start();
