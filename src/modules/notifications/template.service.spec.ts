import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationKind, TemplateService } from './template.service';

const STORE = {
  name: 'Naila Arts',
  supportEmail: 'hello@nailaarts.example',
  locale: 'en',
  currency: 'PKR',
  timezone: 'Asia/Karachi',
};

const config = {
  getOrThrow: (key: string) => (key === 'store.locale' ? STORE.locale : STORE),
} as unknown as ConfigService;

const order = {
  orderNumber: 'NA-1042',
  total: 'PKR 9,000',
  items: [
    {
      name: 'Embroidered Lawn Suit',
      size: 'Medium',
      quantity: 2,
      unitPrice: 'PKR 4,500',
      lineTotal: 'PKR 9,000',
    },
    { name: 'Chiffon Dupatta', size: null, quantity: 1, unitPrice: 'PKR 0', lineTotal: 'PKR 0' },
  ],
};

const SAMPLES: Record<NotificationKind, Record<string, unknown>> = {
  orderPlaced: { order },
  orderPaid: { order },
  orderCancelled: { order },
  orderReturned: { order },
  orderDelivered: { order },
  shipmentDispatched: {
    shipment: {
      orderNumber: 'NA-1042',
      carrier: 'TCS',
      trackingNumber: 'TCS123456789',
      trackingUrl: 'https://track.example.com/TCS123456789',
      estimatedDeliveryAt: '2026-09-20',
    },
  },
  passwordResetCode: { code: '048213', expiresInMinutes: 10 },
  passwordChanged: {},
};

const KINDS = Object.keys(SAMPLES) as NotificationKind[];

describe('TemplateService', () => {
  const templates = new TemplateService(config);
  templates.onModuleInit();

  describe.each(['en', 'tr'])('every email, in %s', (locale) => {
    it.each(KINDS)('%s renders completely', (kind) => {
      const email = templates.render(kind, SAMPLES[kind], 'Ayesha', locale);

      expect(email.subject.trim()).not.toBe('');
      // A leftover placeholder means a missing string or a typo in a key.
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toMatch(/\{\{|\}\}/);
      }
      expect(email.html).toContain('Naila Arts');
      expect(email.html).toContain(STORE.supportEmail);
      expect(email.html).toContain('Ayesha');
      expect(email.text).toContain('NAILA ARTS');
      expect(email.text).toContain('Ayesha');
    });
  });

  it('has the same strings in every locale', () => {
    const load = (locale: string) =>
      JSON.parse(readFileSync(join(__dirname, 'i18n', `${locale}.json`), 'utf8')) as Record<
        string,
        Record<string, string>
      >;
    const keys = (strings: Record<string, Record<string, string>>) =>
      Object.entries(strings).flatMap(([section, values]) =>
        Object.keys(values).map((key) => `${section}.${key}`),
      );

    expect(keys(load('tr')).sort()).toEqual(keys(load('en')).sort());
  });

  it('shows the reset code in the body but never in the subject', () => {
    const email = templates.render('passwordResetCode', SAMPLES.passwordResetCode, 'Ayesha');

    expect(email.subject).not.toContain('048213');
    expect(email.html).toContain('048213');
    expect(email.text).toContain('048213');
    expect(email.html).toContain('10 minutes');
  });

  it('lists each item with its size, quantity and prices', () => {
    const email = templates.render('orderPlaced', SAMPLES.orderPlaced, 'Ayesha');

    expect(email.html).toContain('Embroidered Lawn Suit');
    expect(email.html).toContain('Medium');
    expect(email.html).toContain('PKR 4,500');
    expect(email.html).toContain('PKR 9,000');
    expect(email.text).toContain(
      '- Embroidered Lawn Suit (Size: Medium): 2 × PKR 4,500 = PKR 9,000',
    );
  });

  it('links the tracking page from the dispatch email', () => {
    const email = templates.render('shipmentDispatched', SAMPLES.shipmentDispatched, 'Ayesha');

    expect(email.html).toContain('href="https://track.example.com/TCS123456789"');
    expect(email.text).toContain('https://track.example.com/TCS123456789');
  });

  it('escapes what a customer typed', () => {
    const email = templates.render('orderPlaced', SAMPLES.orderPlaced, '<script>alert(1)</script>');

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});
