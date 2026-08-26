/** Auto-repost is enabled for every mapped bridge topic. Authorization and topic mapping remain enforced by handlers. */
export function canAutoRepostSocialVideoTopic(topicId: number | undefined): boolean {
  return topicId !== undefined;
}

export function allowedSocialVideoTopicIds(): number[] {
  return [];
}
