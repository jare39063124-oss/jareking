/**
 * 许可证契约（ed25519 离线验签，T6.4 实施）。
 */

/** 许可证类型 */
export type LicenseType = 'buyout' | 'trial';

/** 许可证信息（签名由构建机私钥签发，客户端本地验签） */
export interface LicenseInfo {
  licenseId: string;
  type: LicenseType;
  issuedAt: number;
  /** 允许绑定的设备数 */
  deviceLimit: number;
  /** 解锁的高级功能 ID 列表 */
  features: string[];
  /** ed25519 签名（hex） */
  signature: string;
}

/** 激活状态 */
export interface ActivationState {
  active: boolean;
  licenses: LicenseInfo[];
  /** 已绑定设备 ID 列表 */
  boundDevices: string[];
}

/** 可门控的高级功能 ID（与商业化模块对应） */
export type FeatureId =
  | 'pdf.edit'
  | 'batch.convert'
  | 'export.no-watermark'
  | 'templates.pro'
  | 'ai.hosted-quota';
