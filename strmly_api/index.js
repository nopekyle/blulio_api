const functions = require('firebase-functions');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const { getAuth } = require('firebase-admin/auth');
const stripe = require('stripe')('your stripe live key');
admin.initializeApp();

const db = admin.firestore();

const app = express();

app.use(cors());

app.use(express.json());

app.get('/', async (req, res) => {
    return res.status(200).send('hello');
});

app.get('/retrieve/:id', async (req, res) => {
    if (req.params.id == null) {
        return res.status(400).send();
    }

    const subscription = await stripe.subscriptions.retrieve(
        req.params.id
    );

    if (subscription.status != 'active') {
        const result = await db.collection('subscriptions').doc(subscription.id).delete();
        return res.status(200).send(false);
    } else {
        return res.status(200).send(true);
    }

});

app.get('/checkIfActivated/:uid', async (req, res) => {
    const account = await stripe.accounts.retrieve(req.params.uid);

    if (!account) {
        res.status(200).send(false);
    }

    if (account.charges_enabled && account.payouts_enabled) {
        return res.status(200).send(true);
    } else {
        return res.status(200).send(false);
    }

});

app.post('/subscribe/:accountId/:uid/:tier', async (req, res) => {

    let { data } = req.body


    const creatorId = await db.collection('creator').where('accountId', '==', req.params.accountId).get();

    const user = await admin.auth().getUser(req.params.uid);

    const username = await db.collection('user').doc(req.params.uid).get();


    if (creatorId.docs[0].exists && user.email && username.exists) {
        let price;
        if (req.params.tier == 'tier1') {
            price = await stripe.prices.create({
                currency: 'usd',
                unit_amount: 500,
                recurring: {
                    interval: 'month',
                },
                product_data: {
                    name: 'Tier 1',
                },
            });

        } else if (req.params.tier == 'tier2') {
            price = await stripe.prices.create({
                currency: 'usd',
                unit_amount: 1000,
                recurring: {
                    interval: 'month',
                },
                product_data: {
                    name: 'Tier 2',
                },
            });
        } else {
            price = await stripe.prices.create({
                currency: 'usd',
                unit_amount: 1500,
                recurring: {
                    interval: 'month',
                },
                product_data: {
                    name: 'Tier 3',
                },
            });
        }

        const customer = await stripe.customers.create({
            name: username.get('username'),
            email: user.email,
            payment_method: data
        });

        const subscription = await stripe.subscriptions.create(
            {
                application_fee_percent: 20,
                customer: customer.id,
                items: [
                    {
                        price: price.id,
                    },
                ],
                expand: ['latest_invoice.payment_intent'],
                transfer_data: {
                    destination: req.params.accountId,
                },
                payment_behavior: 'default_incomplete',
                payment_settings: { save_default_payment_method: 'on_subscription' }
            }
        );


        if (subscription.id) {
            db.collection('subscriptions').doc(subscription.id).create({
                status: subscription.status,
                creator: req.params.accountId,
                customer: req.params.uid,
                stripe_customer_id: subscription.customer,
                tier: req.params.tier,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.status(200).send({
                subscriptionId: subscription.id,
                clientSecret: subscription.latest_invoice.payment_intent.client_secret,
            });
        }
    }

    return res.status(500).send();

});

app.post('/connect/:uid', async (req, res) => {
    if (req.params.uid == null || req.params.uid == undefined) {
        return res.status(400);
    }
    const user = await db.collection('user').doc(req.params.uid).get();
    if (!user.exists) {
        return res.status(400);
    }
    const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        business_type: 'individual',
        capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
        },
    });


    const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: '', // some url to return to when it doesn't work
        return_url: ``, // a success page, i personally routed to the users profile for easy UX
        type: 'account_onboarding',
    });


    const creator = await db.collection('creator').doc(req.params.uid).create({
        accountId: account.id
    });

    if (creator) {
        return res.status(200).send(accountLink.url);
    } else {
        return res.status(500).send('Something went wrong :(');
    }


});

app.post('/cancel/:uid', async (req, res) => {

    const sub = await db.collection('subscriptions').where('customer', '==', req.params.uid).get();

    if (sub.empty) {
        return res.status(404).send();
    }

    for (let i = 0; i < sub.docs.length; i++) {
        const subscription = await stripe.subscriptions.cancel(sub.docs[i].id);

        await db.collection('subscriptions').doc(sub.docs[i].id).delete().catch((e) => {
            console.log(e);
        });
    }

    return res.status(200).send();

});

exports.app = functions.https.onRequest(app);