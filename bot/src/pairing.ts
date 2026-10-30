/** Invoke only after the webhook secret is verified. No webhook/menu implementation in Task 4. */
import {numericId,unauthorized,type PrivateActor,type FirestoreRepository} from './repository.js';
export function privateActor(update: unknown): PrivateActor {
  if(!update || typeof update!=='object') return unauthorized();
  const u=update as Record<string,any>;
  if(u.business_message || u.edited_business_message || u.channel_post || u.edited_channel_post || u.inline_query || u.chosen_inline_result || u.business_connection || u.deleted_business_messages) return unauthorized();
  const callback=u.callback_query;
  if((u.message && callback) || (!u.message && !callback)) return unauthorized();
  const message=callback ? callback.message : u.message, from=callback ? callback.from : message?.from;
  if(!message || !from || from.is_bot===true || message.chat?.type!=='private' || message.sender_chat ||
    message.forward_origin || message.forward_from || message.forward_from_chat || message.business_connection_id || callback?.inline_message_id) return unauthorized();
  const userId=numericId(from.id), chatId=numericId(message.chat.id);
  if(userId!==chatId) return unauthorized();
  return {userId,chatId,...(typeof from.language_code==='string'?{languageCode:from.language_code}:{})};
}
export async function pairPrivateUpdate(repository: FirestoreRepository, secret: string, update: unknown) {
  const actor=privateActor(update); return repository.pairParent(secret,actor.userId,actor.chatId);
}
