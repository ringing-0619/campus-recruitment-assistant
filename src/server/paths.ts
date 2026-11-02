import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '../..');
export const runtimeDir = join(projectRoot, 'data', 'runtime');
export const databasePath = resolve(
  projectRoot,
  process.env.CAMPUS_DB_PATH || join(runtimeDir, 'campus-assistant.sqlite'),
);
// 新安装使用空库；旧个人数据仅在用户明确指定文件时迁移，不属于发行源码。
export const migrationDataPath = process.env.CAMPUS_LEGACY_DATA_PATH
  ? resolve(projectRoot, process.env.CAMPUS_LEGACY_DATA_PATH)
  : undefined;
export const webDistPath = join(projectRoot, 'dist');
