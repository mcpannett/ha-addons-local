/**
 * MCS wire-framing tags — the 1-byte tag preceding each framed message on Google's MCS/FCM socket.
 *
 * Pure transport framing (login/heartbeat/data-stanza routing); it is NOT a push *event* semantic,
 * so it lives with the push transport, not in the model's push-event vocabulary
 * (the model layer's push-event module). The parser and client are its only consumers.
 * Adapted from mega-yfue/eufy-sdk (Apache-2.0).
 */
export enum MessageTag {
  HeartbeatPing = 0,
  HeartbeatAck = 1,
  LoginRequest = 2,
  LoginResponse = 3,
  Close = 4,
  MessageStanza = 5,
  PresenceStanza = 6,
  IqStanza = 7,
  DataMessageStanza = 8,
  BatchPresenceStanza = 9,
  StreamErrorStanza = 10,
  HttpRequest = 11,
  HttpResponse = 12,
  BindAccountRequest = 13,
  BindAccountResponse = 14,
  TalkMetadata = 15,
  NumProtoTypes = 16,
}
