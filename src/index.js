export default {
  async email(message, env, ctx) {
    console.log(`Email received from ${message.from} to ${message.to}`);
    // Starter Email Worker. We will add voicemail MP3 parsing and VoIP.ms MMS sending next.
  },

  async fetch() {
    return new Response("voicemail-to-mms worker is running", { status: 200 });
  },
};
