import puppeteer from 'puppeteer';

const launchedBrowsers = [];

async function launchBrowser () {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    launchedBrowsers.push(browser);

    browser.on('disconnected', () => {
        console.log('A browser just closed 😢');
        const index = launchedBrowsers.indexOf(browser);
        if (index !== -1) launchedBrowsers.splice(index, 1);
    });

    return browser;
};

(async () => {
    const browser1 = await launchBrowser();
    const browser2 = await launchBrowser();

    console.log('Currently launched browsers:', launchedBrowsers.length);
})();

module.exports = { launchBrowser };