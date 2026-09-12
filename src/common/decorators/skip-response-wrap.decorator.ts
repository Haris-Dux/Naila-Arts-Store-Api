import { SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_WRAP = 'skipResponseWrap';

/** Return the handler's value verbatim, without the success envelope. */
export const SkipResponseWrap = () => SetMetadata(SKIP_RESPONSE_WRAP, true);
