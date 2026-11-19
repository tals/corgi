//! A daemon's review service as tests call it: through JSON both ways, as
//! the protocol decodes a request, without a daemon.
import * as json from "../json";
import * as protocol from "../protocol";
import * as reader from "../review/reader";
import * as service from "../review/service";

export const call: reader.Call = async (op, payload) =>
  json.clone(await service.answer(protocol.decoded(op as service.Op, json.clone(payload)) as never));
export const local = (): reader.Reader => reader.daemon(call);
