/**
 * Minimal typings for the official `futu-api` package (moomoo OpenD WebSocket SDK). The package ships no .d.ts.
 * Only the calls this app uses are declared. Trading methods (Trd_*) are deliberately absent: the app never places orders.
 */
declare module 'futu-api' {
  export default class FtWebsocket {
    onlogin: ((ok: boolean, msg: unknown) => void) | null;
    start(ip: string, port: number, ssl: boolean, key?: string): void;
    stop(): void;
    GetGlobalState(req: unknown): Promise<unknown>;
    GetOptionExpirationDate(req: unknown): Promise<unknown>;
    GetOptionChain(req: unknown): Promise<unknown>;
    GetSecuritySnapshot(req: unknown): Promise<unknown>;
    GetStaticInfo(req: unknown): Promise<unknown>;
    RequestHistoryKL(req: unknown): Promise<unknown>;
    RequestHistoryKLQuota(req: unknown): Promise<unknown>;
    GetOptionUnderlyingHisVolatility(req: unknown): Promise<unknown>;
  }
}
