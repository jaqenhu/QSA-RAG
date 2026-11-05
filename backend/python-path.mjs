import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// External Python cannot read Electron's virtual ASAR paths.
export function pythonScript(name) {
  if (!['parse_workbook.py', 'assessment_workbook.py', 'protect_secret.py'].includes(name)) throw new Error('未知的 Python 脚本。');
  return join(process.env.QSA_PYTHON_SCRIPTS || dirname(fileURLToPath(import.meta.url)), name);
}
