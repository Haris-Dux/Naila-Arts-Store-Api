import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import request from 'supertest';

import {
  PasswordResetCode,
  PasswordResetCodeDocument,
} from '../src/modules/auth/schemas/password-reset-code.schema';
import { MailerService } from '../src/modules/notifications/mailer.service';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createTestApp } from './setup-app';

/**
 * "Forgot password" by emailed code.
 *
 * Most of these are about what must *not* happen: a code working twice, a sixth
 * guess, a reset for someone who is not a customer, or an answer that reveals
 * whether an email is registered. Several fire requests in parallel, because
 * that is where a check-then-write implementation breaks.
 */
describe('Password reset (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let userModel: Model<UserDocument>;
  let codeModel: Model<PasswordResetCodeDocument>;
  let sendSpy: jest.SpyInstance;

  const email = 'ayesha@example.com';
  const password = 'StrongP@ssw0rd!';
  const newPassword = 'N3w-StrongP@ss!';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    // Listen once, up front. Otherwise supertest starts a throwaway listener per
    // request and closes it when that request finishes — cutting off the other
    // requests the concurrency tests below have in flight (ECONNRESET).
    await app.listen(0);
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    codeModel = app.get<Model<PasswordResetCodeDocument>>(getModelToken(PasswordResetCode.name));
    sendSpy = jest.spyOn(app.get(MailerService), 'send');
  }, 120_000);

  afterAll(async () => {
    sendSpy?.mockRestore();
    await ctx?.close();
  });

  beforeEach(async () => {
    await Promise.all([userModel.deleteMany({}), codeModel.deleteMany({})]);
    sendSpy.mockClear();
  });

  const http = () => request(app.getHttpServer());

  const register = async (address = email) => {
    const res = await http()
      .post(api('/auth/register'))
      .send({ name: 'Ayesha Khan', email: address, password })
      .expect(201);
    return {
      id: res.body.data.user.id as string,
      accessToken: res.body.data.tokens.accessToken as string,
      refreshToken: res.body.data.tokens.refreshToken as string,
    };
  };

  const forgot = (address = email) =>
    http().post(api('/auth/forgot-password')).send({ email: address });

  const reset = (code: string, pw = newPassword, address = email) =>
    http().post(api('/auth/reset-password')).send({ email: address, code, newPassword: pw });

  const login = (pw: string) => http().post(api('/auth/login')).send({ email, password: pw });

  const mails = () =>
    sendSpy.mock.calls.map(
      (call) => call[0] as { to: string; subject: string; html: string; text: string },
    );

  const codeMails = () => mails().filter((mail) => /password reset code/i.test(mail.subject));

  /** The code in the most recent reset email. */
  const latestCode = () => {
    const mail = codeMails().at(-1);
    const match = mail && /: (\d{6})\n/.exec(mail.text);
    if (!match) throw new Error('No reset code has been emailed');
    return match[1];
  };

  /** Skip the one-minute cool-down, as if the customer had waited. */
  const waitOutCooldown = () => codeModel.updateMany({}, { $set: { lastSentAt: new Date(0) } });

  /** A code that is certainly not the one emailed. */
  const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

  describe('asking for a code', () => {
    it('emails a customer a six-digit code, and never puts it in the subject', async () => {
      await register();

      await forgot().expect(202);

      expect(codeMails()).toHaveLength(1);
      const mail = codeMails()[0];
      expect(mail.to).toBe(email);
      expect(latestCode()).toMatch(/^\d{6}$/);
      expect(mail.subject).not.toContain(latestCode());
      expect(mail.html).toContain(latestCode());
    });

    it('gives an unknown email exactly the same answer, and sends nothing', async () => {
      await register();
      const known = await forgot().expect(202);
      sendSpy.mockClear();

      const unknown = await forgot('nobody@example.com').expect(202);

      expect(unknown.body.data).toEqual(known.body.data);
      expect(mails()).toHaveLength(0);
    });

    it('sends nothing to a staff account', async () => {
      const { id } = await register();
      await userModel.updateOne({ _id: id }, { $set: { role: UserRole.ADMIN } });

      await forgot().expect(202);

      expect(mails()).toHaveLength(0);
    });

    it('sends nothing to a deactivated account', async () => {
      const { id } = await register();
      await userModel.updateOne({ _id: id }, { $set: { isActive: false } });

      await forgot().expect(202);

      expect(mails()).toHaveLength(0);
    });

    it('sends nothing again within a minute, and the first code keeps working', async () => {
      await register();
      await forgot().expect(202);
      const first = latestCode();

      await forgot().expect(202);

      expect(codeMails()).toHaveLength(1);
      await reset(first).expect(204);
    });

    it('sends at most five codes an hour', async () => {
      await register();

      for (let i = 0; i < 7; i += 1) {
        await forgot().expect(202);
        await waitOutCooldown();
      }

      expect(codeMails()).toHaveLength(5);
    });

    it('sends one code when two requests arrive together', async () => {
      await register();

      await Promise.all([forgot().expect(202), forgot().expect(202)]);

      expect(codeMails()).toHaveLength(1);
    });

    it('stores only a keyed hash of the code', async () => {
      await register();
      await forgot().expect(202);
      const code = latestCode();

      const stored = await codeModel.findOne({}).lean().exec();

      expect(stored?.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored?.codeHash).not.toContain(code);
      // Not a plain hash either — that would fall to trying a million codes.
      expect(stored?.codeHash).not.toBe(createHash('sha256').update(code).digest('hex'));
    });
  });

  describe('using the code', () => {
    it('sets the new password and signs out every session', async () => {
      const session = await register();
      await forgot().expect(202);

      await reset(latestCode()).expect(204);

      await login(password).expect(401);
      await login(newPassword).expect(200);
      // Old refresh token: cannot mint new tokens.
      await http()
        .post(api('/auth/refresh'))
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      // Old access token: stops working now, not when it expires.
      await http()
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(401);
    });

    it('emails a confirmation that the password changed', async () => {
      await register();
      await forgot().expect(202);

      await reset(latestCode()).expect(204);

      const confirmation = mails().filter((mail) => /password was changed/i.test(mail.subject));
      expect(confirmation).toHaveLength(1);
      expect(confirmation[0].to).toBe(email);
    });

    it('rejects a wrong code with the one generic error', async () => {
      await register();
      await forgot().expect(202);

      const res = await reset(wrongCode(latestCode())).expect(400);

      expect(res.body.code).toBe('INVALID_RESET_CODE');
      expect(res.body.message).toBe('The code is invalid or has expired');
    });

    it('stops accepting a code after five wrong guesses — even the right one', async () => {
      await register();
      await forgot().expect(202);
      const code = latestCode();

      for (let i = 0; i < 5; i += 1) await reset(wrongCode(code)).expect(400);

      await reset(code).expect(400);
      await login(password).expect(200);
    });

    it('spends exactly five guesses when ten arrive at once', async () => {
      await register();
      await forgot().expect(202);
      const code = latestCode();

      await Promise.all(Array.from({ length: 10 }, () => reset(wrongCode(code)).expect(400)));

      expect((await codeModel.findOne({}).lean().exec())?.attempts).toBe(5);
      await reset(code).expect(400);
    });

    it('rejects an expired code', async () => {
      await register();
      await forgot().expect(202);
      await codeModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      await reset(latestCode()).expect(400);
      await login(password).expect(200);
    });

    it('works only once', async () => {
      await register();
      await forgot().expect(202);
      const code = latestCode();

      await reset(code).expect(204);
      await reset(code, 'An0ther-StrongP@ss!').expect(400);

      await login(newPassword).expect(200);
    });

    it('lets exactly one of two simultaneous resets through', async () => {
      await register();
      await forgot().expect(202);
      const code = latestCode();

      const statuses = (
        await Promise.all([reset(code, newPassword), reset(code, 'An0ther-StrongP@ss!')])
      ).map((res) => res.status);

      expect(statuses.sort()).toEqual([204, 400]);
    });

    it('stops the previous code working once a new one is sent', async () => {
      await register();
      await forgot().expect(202);
      const first = latestCode();
      await waitOutCooldown();
      await forgot().expect(202);
      const second = latestCode();

      // One chance in a million the two codes are equal; the check below would
      // then be meaningless rather than wrong.
      if (first !== second) await reset(first).expect(400);
      await reset(second).expect(204);
    });

    it('refuses a weak new password without using up a guess', async () => {
      await register();
      await forgot().expect(202);

      await reset(latestCode(), 'weak').expect(400);

      expect((await codeModel.findOne({}).lean().exec())?.attempts).toBe(0);
      await reset(latestCode()).expect(204);
    });

    it('refuses a malformed code before looking anything up', async () => {
      await register();
      await forgot().expect(202);

      const res = await reset('12ab56').expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('gives an unknown email the same error as a wrong code', async () => {
      const res = await reset('123456', newPassword, 'nobody@example.com').expect(400);

      expect(res.body.code).toBe('INVALID_RESET_CODE');
    });

    it("never resets a staff account's password", async () => {
      await register();
      await forgot().expect(202);
      const code = latestCode();
      await userModel.updateOne({ email }, { $set: { role: UserRole.ADMIN } });

      await reset(code).expect(400);
      await login(password).expect(200);
    });
  });
});
