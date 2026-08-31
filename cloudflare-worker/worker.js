/**
 * =============================================================
 *  Cloudflare Email Worker — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  هذا العامل (Worker) يستقبل أي رسالة تُرسل إلى دومينك المُدار
 *  على Cloudflare، ثم يعيد توجيهها إلى سيرفر ظرف عبر HTTP.
 *
 *  لماذا؟ لأن بورت 25 (بورت استقبال البريد) محجوب على أغلب
 *  الاستضافات المجانية، بينما Cloudflare Email Routing مجاني بالكامل.
 *
 *  طريقة الإعداد (ملخّص — التفاصيل في README):
 *    1) أضف دومينك إلى Cloudflare.
 *    2) Email → Email Routing → Routing rules:
 *         Custom address: *@yourdomain.com  →  Send to a Worker: zarf-inbound
 *    3) أنشئ Worker بهذا الكود واربطه (Email handler).
 *    4) اضبط المتغيرات في إعدادات الـ Worker:
 *         ZARF_WEBHOOK_URL = https://your-server.com/api/inbound/webhook
 *         ZARF_WEBHOOK_KEY = نفس قيمة INBOUND_WEBHOOK_KEY في ملف .env
 *    5) أضف الدومين إلى MAIL_DOMAINS في ملف .env وأعد تشغيل السيرفر.
 * =============================================================
 */

export default {
  /**
   * معالج البريد الوارد (يُستدعى تلقائياً من Cloudflare Email Routing)
   */
  async email(message, env, ctx) {
    try {
      // message.raw هو Stream للرسالة كاملة بصيغة RFC822
      const rawEmail = await new Response(message.raw).text();

      const response = await fetch(env.ZARF_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'message/rfc822',
          'x-zarf-webhook-key': env.ZARF_WEBHOOK_KEY,
          'user-agent': 'zarf-cloudflare-worker/1.0',
        },
        body: rawEmail,
      });

      if (!response.ok) {
        console.error('Zarf webhook error:', response.status, await response.text());
        // إعادة المحاولة مرة واحدة بعد ثانية
        ctx.waitUntil(
          new Promise((resolve) => setTimeout(() => {
            fetch(env.ZARF_WEBHOOK_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'message/rfc822',
                'x-zarf-webhook-key': env.ZARF_WEBHOOK_KEY,
              },
              body: rawEmail,
            }).then(resolve).catch(resolve);
          }, 1000))
        );
      }

      // message.forward(...) ممكن أيضاً لو أردت إعادة التوجيه لبريد حقيقي
    } catch (error) {
      console.error('Worker failed:', error.message);
    }
  },

  /**
   * معالج HTTP بسيط للتحقق من أن العامل يعمل
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        service: 'zarf-inbound-worker',
        ok: true,
        target: env.ZARF_WEBHOOK_URL,
        time: Date.now(),
      }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return new Response('ظرف Zarf Mail — Inbound Worker is alive ✉️', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
