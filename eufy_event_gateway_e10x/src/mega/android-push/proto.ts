/**
 * Google MCS + Android check-in protobuf schemas, embedded as strings so they
 * ship in the build without a file-copy step (protobufjs `parse()` instead of
 * `load()`). These are Google's public protocol definitions (Chromium MCS /
 * GServices check-in), not eufy code. The transport adaptation is derived
 * from mega-yfue/eufy-sdk (Apache-2.0).
 */
import type { Root } from "protobufjs";
import { protobufjs } from "./protobuf.js";

/** MCS stanza definitions consumed by the socket parser and login client. */
export const MCS_PROTO = `
syntax = "proto2";
option optimize_for = LITE_RUNTIME;
package mcs_proto;

message HeartbeatPing {
  optional int32 stream_id = 1;
  optional int32 last_stream_id_received = 2;
  optional int64 status = 3;
}
message HeartbeatAck {
  optional int32 stream_id = 1;
  optional int32 last_stream_id_received = 2;
  optional int64 status = 3;
}
message ErrorInfo {
  required int32 code = 1;
  optional string message = 2;
  optional string type = 3;
  optional Extension extension = 4;
}
message Setting {
  required string name = 1;
  required string value = 2;
}
message HeartbeatStat {
  required string ip = 1;
  required bool timeout = 2;
  required int32 interval_ms = 3;
}
message HeartbeatConfig {
  optional bool upload_stat = 1;
  optional string ip = 2;
  optional int32 interval_ms = 3;
}
message ClientEvent {
  enum Type { UNKNOWN = 0; DISCARDED_EVENTS = 1; FAILED_CONNECTION = 2; SUCCESSFUL_CONNECTION = 3; }
  optional Type type = 1;
  optional uint32 number_discarded_events = 100;
  optional int32 network_type = 200;
  reserved 201;
  optional uint64 time_connection_started_ms = 202;
  optional uint64 time_connection_ended_ms = 203;
  optional int32 error_code = 204;
  optional uint64 time_connection_established_ms = 300;
}
message LoginRequest {
  enum AuthService { ANDROID_ID = 2; }
  required string id = 1;
  required string domain = 2;
  required string user = 3;
  required string resource = 4;
  required string auth_token = 5;
  optional string device_id = 6;
  optional int64 last_rmq_id = 7;
  repeated Setting setting = 8;
  repeated string received_persistent_id = 10;
  optional bool adaptive_heartbeat = 12;
  optional HeartbeatStat heartbeat_stat = 13;
  optional bool use_rmq2 = 14;
  optional int64 account_id = 15;
  optional AuthService auth_service = 16;
  optional int32 network_type = 17;
  optional int64 status = 18;
  reserved 19, 20, 21;
  repeated ClientEvent client_event = 22;
}
message LoginResponse {
  required string id = 1;
  optional string jid = 2;
  optional ErrorInfo error = 3;
  repeated Setting setting = 4;
  optional int32 stream_id = 5;
  optional int32 last_stream_id_received = 6;
  optional HeartbeatConfig heartbeat_config = 7;
  optional int64 server_timestamp = 8;
}
message StreamErrorStanza {
  required string type = 1;
  optional string text = 2;
}
message Close {}
message Extension {
  required int32 id = 1;
  required bytes data = 2;
}
message IqStanza {
  enum IqType { GET = 0; SET = 1; RESULT = 2; IQ_ERROR = 3; }
  optional int64 rmq_id = 1;
  required IqType type = 2;
  required string id = 3;
  optional string from = 4;
  optional string to = 5;
  optional ErrorInfo error = 6;
  optional Extension extension = 7;
  optional string persistent_id = 8;
  optional int32 stream_id = 9;
  optional int32 last_stream_id_received = 10;
  optional int64 account_id = 11;
  optional int64 status = 12;
}
message AppData {
  required string key = 1;
  required string value = 2;
}
message DataMessageStanza {
  optional string id = 2;
  required string from = 3;
  optional string to = 4;
  required string category = 5;
  optional string token = 6;
  repeated AppData app_data = 7;
  optional bool from_trusted_server = 8;
  optional string persistent_id = 9;
  optional int32 stream_id = 10;
  optional int32 last_stream_id_received = 11;
  optional string reg_id = 13;
  optional int64 device_user_id = 16;
  optional int32 ttl = 17;
  optional int64 sent = 18;
  optional int32 queued = 19;
  optional int64 status = 20;
  optional bytes raw_data = 21;
  optional bool immediate_ack = 24;
}
message StreamAck {}
message SelectiveAck { repeated string id = 1; }
`;

/** Android GServices check-in definitions consumed during FCM registration. */
export const CHECKIN_PROTO = `
syntax = "proto2";
option optimize_for = LITE_RUNTIME;

message CheckinRequest {
  optional string imei = 1;
  optional int64 androidId = 2;
  optional string digest = 3;
  required Checkin checkin = 4;
  message Checkin {
    required Build build = 1;
    message Build {
      optional string fingerprint = 1;
      optional string hardware = 2;
      optional string brand = 3;
      optional string radio = 4;
      optional string bootloader = 5;
      optional string clientId = 6;
      optional int64 time = 7;
      optional int32 packageVersionCode = 8;
      optional string device = 9;
      optional int32 sdkVersion = 10;
      optional string model = 11;
      optional string manufacturer = 12;
      optional string product = 13;
      optional bool otaInstalled = 14;
    }
    optional int64 lastCheckinMs = 2;
    repeated Event event = 3;
    message Event {
      optional string tag = 1;
      optional string value = 2;
      optional int64 timeMs = 3;
    }
    repeated Statistic stat = 4;
    message Statistic {
      required string tag = 1;
      optional int32 count = 2;
      optional float sum = 3;
    }
    repeated string requestedGroup = 5;
    optional string cellOperator = 6;
    optional string simOperator = 7;
    optional string roaming = 8;
    optional int32 userNumber = 9;
  }
  optional string desiredBuild = 5;
  optional string locale = 6;
  optional int64 loggingId = 7;
  optional string marketCheckin = 8;
  repeated string macAddress = 9;
  optional string meid = 10;
  repeated string accountCookie = 11;
  optional string timeZone = 12;
  optional fixed64 securityToken = 13;
  optional int32 version = 14;
  repeated string otaCert = 15;
  optional string serial = 16;
  optional string esn = 17;
  repeated string macAddressType = 19;
  required int32 fragment = 20;
  optional string userName = 21;
  optional int32 userSerialNumber = 22;
}

message CheckinResponse {
  optional bool statsOk = 1;
  repeated Intent intent = 2;
  message Intent {
    optional string action = 1;
    optional string dataUri = 2;
    optional string mimeType = 3;
    optional string javaClass = 4;
    repeated Extra extra = 5;
    message Extra {
      optional string name = 6;
      optional string value = 7;
    }
  }
  optional int64 timeMs = 3;
  optional string digest = 4;
  repeated GservicesSetting setting = 5;
  message GservicesSetting {
    optional bytes name = 1;
    optional bytes value = 2;
  }
  optional bool marketOk = 6;
  optional fixed64 androidId = 7;
  optional fixed64 securityToken = 8;
  optional bool settingsDiff = 9;
  repeated string deleteSetting = 10;
  optional string versionInfo = 11;
  optional string deviceDataVersionInfo = 12;
}
`;

/**
 * The parsed roots, one per document, parsed on first use.
 *
 * Here rather than beside the consumers because both `McsParser` and `PushClient` want the SAME MCS
 * root: a lazy root per file would parse the document twice for no reason. Keeping `protobufjs` out of
 * this module's imports is what makes that free — these are function bodies, so the engine still loads
 * only when a root is actually asked for.
 */
let mcs: Root | undefined;

/** Share one lazily parsed MCS schema across socket framing and login. */
export const mcsRoot = (): Root => (mcs ??= protobufjs().parse(MCS_PROTO).root);

let checkin: Root | undefined;

/** Lazily parse the GServices check-in schema when registering a new device. */
export const checkinRoot = (): Root => (checkin ??= protobufjs().parse(CHECKIN_PROTO).root);
