import { Controller as View } from "../controller";
import { Parser, type Input } from "../terminal_input";

/** Raw input enters tests through the same decoder as a live viewer. */
export class Controller extends View {
  readonly input_parser = new Parser();
  override input(data: Uint8Array | readonly Input[], current = () => true, dropped = false): Promise<void> {
    return super.input(data instanceof Uint8Array ? this.input_parser.feed(data, Date.now()) : data, current, dropped);
  }
  override async expireInput(current = () => true, dropped = false): Promise<void> {
    await this.input(this.input_parser.expire(Date.now()), current, dropped);
    await super.expireInput(current, dropped);
  }
}
