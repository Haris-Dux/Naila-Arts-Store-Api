import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Handlebars from 'handlebars';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoreConfig } from '../../config/configuration';

export type NotificationKind =
  | 'orderPlaced'
  | 'orderPaid'
  | 'orderCancelled'
  | 'orderReturned'
  | 'orderDelivered'
  | 'shipmentDispatched'
  | 'passwordResetCode'
  | 'passwordChanged';

/** Strings for one locale. Nested one level: section → key → string. */
type Translations = Record<string, Record<string, string>>;

export interface RenderedEmail {
  subject: string;
  html: string;
  /** The same message as plain text — sent alongside the HTML. */
  text: string;
}

interface OrderLine {
  name: string;
  size?: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

interface OrderData {
  orderNumber: string;
  total: string;
  items: OrderLine[];
}

interface ShipmentData {
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string | null;
  estimatedDeliveryAt?: string | null;
}

const TEMPLATE_DIR = join(__dirname, 'templates');
const I18N_DIR = join(__dirname, 'i18n');
const SUPPORTED_LOCALES = ['en', 'tr'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The body each email puts inside the shared layout. */
const BODY_TEMPLATE: Record<NotificationKind, string> = {
  orderPlaced: 'order-summary',
  orderPaid: 'order-summary',
  orderCancelled: 'order-summary',
  orderReturned: 'order-summary',
  orderDelivered: 'order-summary',
  shipmentDispatched: 'shipment-dispatched',
  passwordResetCode: 'password-reset-code',
  passwordChanged: 'password-changed',
};

const TEMPLATES = ['layout', ...new Set(Object.values(BODY_TEMPLATE))];

/**
 * Renders the store's emails from template files, in the recipient's locale.
 *
 * Every email shares one branded layout (`layout.hbs`) around a body chosen per
 * kind. Wording lives in `i18n/*.json`; branding and the support address come
 * from configuration. Each email is rendered twice — HTML and plain text — from
 * the same strings, so the two can never disagree.
 */
@Injectable()
export class TemplateService implements OnModuleInit {
  private readonly logger = new Logger(TemplateService.name);
  private readonly translations = new Map<string, Translations>();
  private readonly templates = new Map<string, HandlebarsTemplateDelegate>();
  private readonly store: StoreConfig;
  private readonly defaultLocale: SupportedLocale;

  constructor(config: ConfigService) {
    this.store = config.getOrThrow<StoreConfig>('store');
    this.defaultLocale = TemplateService.normaliseLocale(config.getOrThrow<string>('store.locale'));
  }

  onModuleInit(): void {
    // Compiled once at boot: rendering happens on the queue's hot path, and a
    // missing template should fail at startup rather than at send time.
    for (const name of TEMPLATES) {
      this.templates.set(
        name,
        Handlebars.compile(readFileSync(join(TEMPLATE_DIR, `${name}.hbs`), 'utf8')),
      );
    }

    for (const locale of SUPPORTED_LOCALES) {
      this.translations.set(
        locale,
        JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8')) as Translations,
      );
    }

    this.logger.log(
      `Loaded ${this.templates.size} templates, locales [${SUPPORTED_LOCALES.join(', ')}], default ${this.defaultLocale}`,
    );
  }

  private static normaliseLocale(locale: string): SupportedLocale {
    const base = locale.toLowerCase().split('-')[0];
    return (SUPPORTED_LOCALES as readonly string[]).includes(base)
      ? (base as SupportedLocale)
      : 'en';
  }

  /** Interpolate `{{placeholders}}` in a translated string. */
  private interpolate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
  }

  /** Every string in a section, with its placeholders filled in. */
  private fill(section: Record<string, string>, values: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(section).map(([key, value]) => [key, this.interpolate(value, values)]),
    );
  }

  render(
    kind: NotificationKind,
    data: Record<string, unknown>,
    recipientName: string,
    locale?: string,
  ): RenderedEmail {
    const lang = locale ? TemplateService.normaliseLocale(locale) : this.defaultLocale;
    // Falls back rather than throwing: a missing locale must not stop a
    // customer being told their order shipped.
    const t = this.translations.get(lang) ?? this.translations.get('en')!;
    const english = this.translations.get('en')!;

    const order = data.order as OrderData | undefined;
    const shipment = data.shipment as ShipmentData | undefined;
    const values: Record<string, string> = {
      name: recipientName,
      storeName: this.store.name,
      supportEmail: this.store.supportEmail,
      orderNumber: order?.orderNumber ?? shipment?.orderNumber ?? '',
      minutes: typeof data.expiresInMinutes === 'number' ? String(data.expiresInMinutes) : '',
    };

    const copy = this.fill(t[kind] ?? english[kind], values);
    const common = this.fill(t.common ?? english.common, values);

    const body = this.templates.get(BODY_TEMPLATE[kind])!({
      t,
      copy,
      common,
      ...data,
      storeName: this.store.name,
      supportEmail: this.store.supportEmail,
    });

    const html = this.templates.get('layout')!({
      lang,
      storeName: this.store.name,
      supportEmail: this.store.supportEmail,
      year: new Date().getFullYear(),
      preheader: copy.preheader,
      status: copy.status,
      heading: copy.heading,
      greeting: common.greeting,
      intro: copy.intro,
      nextSteps: copy.nextSteps,
      signoff: common.signoff,
      supportLead: common.supportLead,
      footerNote: common.footerNote,
      // Triple-stash in the layout: the body is our own rendered HTML, and its
      // interpolated values were escaped when that template ran.
      body,
    });

    return {
      subject: copy.subject,
      html,
      text: this.text(kind, copy, common, order, shipment, data),
    };
  }

  /** The plain-text version, built from the same strings as the HTML. */
  private text(
    kind: NotificationKind,
    copy: Record<string, string>,
    common: Record<string, string>,
    order: OrderData | undefined,
    shipment: ShipmentData | undefined,
    data: Record<string, unknown>,
  ): string {
    let details: string[] = [];

    if (order) {
      details = [
        `${common.orderNumber}: ${order.orderNumber}`,
        '',
        ...order.items.map(
          (item) =>
            `- ${item.name}${item.size ? ` (${common.size}: ${item.size})` : ''}: ` +
            `${item.quantity} × ${item.unitPrice} = ${item.lineTotal}`,
        ),
        '',
        `${common.total}: ${order.total}`,
      ];
    } else if (shipment) {
      details = [
        `${common.orderNumber}: ${shipment.orderNumber}`,
        `${copy.carrier}: ${shipment.carrier}`,
        `${copy.trackingNumber}: ${shipment.trackingNumber}`,
        ...(shipment.estimatedDeliveryAt
          ? [`${copy.estimatedDelivery}: ${shipment.estimatedDeliveryAt}`]
          : []),
        ...(shipment.trackingUrl ? ['', `${copy.trackLink}: ${shipment.trackingUrl}`] : []),
      ];
    } else if (kind === 'passwordResetCode') {
      details = [`${copy.codeLabel}: ${String(data.code)}`, copy.expiry, '', copy.ignore];
    } else if (kind === 'passwordChanged') {
      details = [`${copy.notYou} ${this.store.supportEmail}`];
    }

    return (
      [
        this.store.name.toUpperCase(),
        copy.heading,
        common.greeting,
        copy.intro,
        details.join('\n'),
        copy.nextSteps,
        `${common.signoff}\n${common.supportLead} ${this.store.supportEmail}`,
      ]
        .filter((part) => part && part.trim())
        .join('\n\n') + '\n'
    );
  }
}
