// 图标集合：统一用内联 SVG，避免额外引入图标库依赖
// 所有图标都走同一个 Svg 外壳，线条颜色继承 currentColor，方便用 CSS 统一控制颜色和大小
import type { ReactNode, SVGProps } from 'react';

// 图标通用属性：size 控制宽高，其余属性透传给 <svg>
export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

// 外壳：统一 viewBox / 描边风格，内部只写路径
function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

// —— 主体功能图标 ——

// 放大镜：研究员子 Agent
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);

// 终端命令行：编码员子 Agent
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Svg>
);

// 对勾：审查员子 Agent、完成状态
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 13 4 4L19 7" />
  </Svg>
);

// 芯片：通用子 Agent
export const IconCpu = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
  </Svg>
);

// 扳手：工具调用
export const IconWrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0 5 5l-8.6 8.6a2 2 0 0 1-2.8 0l-2.2-2.2a2 2 0 0 1 0-2.8z" />
  </Svg>
);

// 闪电：思考过程
export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8" />
  </Svg>
);

// 沙漏：进行中
export const IconHourglass = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3h10M7 21h10M8 3c0 4 8 5 8 9s-8 5-8 9" />
  </Svg>
);

// 折叠箭头（用 CSS 旋转控制展开/收起方向）
export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

// 发送：输入框提交按钮
export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11.5 20 4l-7.5 16-2-6.5z" />
  </Svg>
);

// 盾牌：审批弹窗标题
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

// 铅笔：编辑参数
export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L20 8l-4-4L4 16z" />
    <path d="m14 6 4 4" />
  </Svg>
);

// 叉号：拒绝 / 关闭
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

// 用户：聊天里的用户消息头像
export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
  </Svg>
);

// 机器人：助手消息头像
export const IconBot = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" />
  </Svg>
);

// 感叹号：错误提示
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </Svg>
);

// 箭头向下：回到底部
export const IconArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
