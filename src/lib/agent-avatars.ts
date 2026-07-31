import strategistAvatar from '@/assets/agent-avatars/strategist.webp';
import creatorAvatar from '@/assets/agent-avatars/creator.webp';
import engineerAvatar from '@/assets/agent-avatars/engineer.webp';
import adBuyerAvatar from '@/assets/agent-avatars/ad-buyer.webp';
import copywriterAvatar from '@/assets/agent-avatars/copywriter.webp';
import slidesAvatar from '@/assets/agent-avatars/slides.webp';
import ecommerceAvatar from '@/assets/agent-avatars/ecommerce.webp';
import supportAvatar from '@/assets/agent-avatars/support.webp';
import analystAvatar from '@/assets/agent-avatars/analyst.webp';
import operatorAvatar from '@/assets/agent-avatars/operator.webp';
import openclawDefaultAgentAvatar from '@/assets/openclaw-default-agent.png';

export interface AgentAvatarOption {
  id: string;
  src: string;
  accentClass: string;
}

export const AGENT_AVATARS: AgentAvatarOption[] = [
  { id: 'strategist', src: strategistAvatar, accentClass: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  { id: 'creator', src: creatorAvatar, accentClass: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  { id: 'engineer', src: engineerAvatar, accentClass: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  { id: 'ad-buyer', src: adBuyerAvatar, accentClass: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  { id: 'copywriter', src: copywriterAvatar, accentClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  { id: 'slides', src: slidesAvatar, accentClass: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' },
  { id: 'ecommerce', src: ecommerceAvatar, accentClass: 'bg-orange-500/10 text-orange-700 dark:text-orange-300' },
  { id: 'support', src: supportAvatar, accentClass: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300' },
  { id: 'analyst', src: analystAvatar, accentClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  { id: 'operator', src: operatorAvatar, accentClass: 'bg-teal-500/10 text-teal-700 dark:text-teal-300' },
];

export const DEFAULT_AGENT_AVATAR_SRC = openclawDefaultAgentAvatar;

export function getAgentAvatar(id: string | undefined | null): AgentAvatarOption {
  return AGENT_AVATARS.find((avatar) => avatar.id === id) ?? AGENT_AVATARS[0];
}
