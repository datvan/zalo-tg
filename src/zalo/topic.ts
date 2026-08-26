export interface TopicProfile {
  displayName?: string;
  zaloName?: string;
}

export interface TopicDisplayNameInput {
  type: 0 | 1;
  zaloId: string;
  senderName: string;
  isSelf: boolean;
  profile?: TopicProfile;
}

export function resolveTopicDisplayName(input: TopicDisplayNameInput): string {
  if (input.type === 0) {
    const profileName = input.profile?.displayName?.trim() || input.profile?.zaloName?.trim();
    if (profileName) return profileName;
    if (input.isSelf) return `Zalo ${input.zaloId}`;
  }
  return input.senderName;
}
