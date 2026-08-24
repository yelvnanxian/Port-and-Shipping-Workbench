export class RequestValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export function requiredString(value: unknown, field: string, maxLength = 256) {
  if (typeof value !== 'string') throw new RequestValidationError(`${field}必须是文本`);
  const result = value.trim();
  if (!result) throw new RequestValidationError(`${field}不能为空`);
  if (result.length > maxLength) throw new RequestValidationError(`${field}长度不能超过 ${maxLength} 个字符`);
  return result;
}

export function optionalString(value: unknown, field: string, maxLength = 256) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RequestValidationError(`${field}必须是文本`);
  const result = value.trim();
  if (result.length > maxLength) throw new RequestValidationError(`${field}长度不能超过 ${maxLength} 个字符`);
  return result;
}

export function stringArray(value: unknown, field: string, options: { maxItems?: number; maxLength?: number } = {}) {
  const maxItems = options.maxItems ?? 100;
  const maxLength = options.maxLength ?? 128;
  if (!Array.isArray(value)) throw new RequestValidationError(`${field}必须是数组`);
  if (value.length > maxItems) throw new RequestValidationError(`${field}一次最多 ${maxItems} 项`);
  return value.map((item) => requiredString(item, field, maxLength));
}

export function optionalStringArray(value: unknown, field: string, options: { maxItems?: number; maxLength?: number } = {}) {
  if (value === undefined) return undefined;
  return stringArray(value, field, options);
}

export function recordIds(value: unknown, field: string, pattern: RegExp, maxItems = 100) {
  const values = stringArray(value, field, { maxItems, maxLength: 160 });
  for (const item of values) if (!pattern.test(item)) throw new RequestValidationError(`${field}包含不合法编号`);
  return [...new Set(values)];
}

export const shipmentIdPattern = /^XLSX-[1-9]\d{0,8}$/;
export const clearanceHistoryIdPattern = /^CLR-[a-z0-9]{6,16}-[a-z0-9]{6,16}$/;
export const runIdPattern = /^RUN-\d{8,20}$/;
export const taskIdPattern = /^TASK-[A-Za-z0-9-]{8,80}$/;
export const userIdPattern = /^user-[A-Za-z0-9]{8,40}$/;
export const backupNamePattern = /^[^/\\\0]{1,180}\.xlsx$/i;

export function assertBodyObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('请求体格式不正确');
  return value as Record<string, unknown>;
}
