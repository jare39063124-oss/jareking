/**
 * 本地账户与积分契约（v1 无服务端，全部本地存储）。
 */

/** 本地账户（设备绑定） */
export interface LocalAccount {
  id: string;
  deviceId: string;
  nickname: string;
  createdAt: number;
}

/** 积分变动原因 */
export type PointsReason =
  | 'signup' // 新用户赠送
  | 'redeem' // 兑换码充值
  | 'ai-consume' // AI 调用消耗
  | 'feature' // 高级功能解锁消耗
  | 'buyout-monthly' // 买断版每月赠送
  | 'ad-reward' // 看广告（预留，v1 未接入）
  | 'manual-adjust' // 人工调整
  | 'refund'; // 退款冲正

/** 积分流水条目 */
export interface PointsEntry {
  id: string;
  /** 正 = 入账，负 = 消耗 */
  delta: number;
  /** 变动后余额（对账依据，写入时校验连续性） */
  balanceAfter: number;
  reason: PointsReason;
  detail?: string;
  createdAt: number;
}

/** 积分余额 */
export interface PointsBalance {
  balance: number;
  updatedAt: number;
}

/** 账户导出文件（换机迁移，T7.1 使用） */
export interface AccountBackup {
  version: 1;
  account: LocalAccount;
  balance: PointsBalance;
  entries: PointsEntry[];
  exportedAt: number;
}
