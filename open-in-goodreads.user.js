// ==UserScript==
// @name         Open in Goodreads
// @namespace    open-in-goodreads
// @version      3.2
// @description  Adds a button to Amazon book pages to redirect to Goodreads page based on ASIN/ISBN
// @match        https://*.amazon.com/*
// @match        https://*.amazon.co.uk/*
// @match        https://*.amazon.com.au/*
// @match        https://*.amazon.com.be/*
// @match        https://*.amazon.com.br/*
// @match        https://*.amazon.ca/*
// @match        https://*.amazon.cn/*
// @match        https://*.amazon.eg/*
// @match        https://*.amazon.fr/*
// @match        https://*.amazon.de/*
// @match        https://*.amazon.in/*
// @match        https://*.amazon.it/*
// @match        https://*.amazon.co.jp/*
// @match        https://*.amazon.com.mx/*
// @match        https://*.amazon.nl/*
// @match        https://*.amazon.pl/*
// @match        https://*.amazon.sa/*
// @match        https://*.amazon.sg/*
// @match        https://*.amazon.es/*
// @match        https://*.amazon.se/*
// @match        https://*.amazon.com.tr/*
// @match        https://*.amazon.ae/*
// @grant        none
// @license      MIT
// @icon         https://www.goodreads.com/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/rycpot/userscripts-public/main/open-in-goodreads.user.js
// @updateURL    https://raw.githubusercontent.com/rycpot/userscripts-public/main/open-in-goodreads.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ASIN/ISBN DETECTION = Checks for ASIN/ISBN
    function extractASIN() {
        let asinElements = document.getElementsByName('ASIN');
        if (asinElements.length === 0)
            asinElements = document.getElementsByName('ASIN.0');

        if (asinElements.length > 0)
            return asinElements[0].value || null;

        return null;
    }

    // REDIRECT LOGIC - Uses ASIN/ISBN to open book page on Goodreads
    function redirectToGoodreads() {
        const asin = extractASIN();

        if (!asin) {
            alert("No ASIN or ISBN Found.");
            return;
        }

        let goodreadsUrl;

        if (/^\d+$/.test(asin)) {
            // ISBN
            goodreadsUrl = `https://www.goodreads.com/review/isbn/${asin}`;
        } else {
            // ASIN fallback
            goodreadsUrl = `https://www.goodreads.com/book/isbn?isbn=${asin}`;
        }

        window.open(goodreadsUrl, '_blank');
    }

    // CHECK IF PAGE IS A BOOK
    function isBookPage() {
        const pubKeywords = [
            "Publication date", "Published", "Date de publication",
            "Veröffentlichungsdatum", "Fecha de publicación",
            "Data di pubblicazione", "出版日"
        ];

        const containers = [
            document.querySelector('#detailBullets_feature_div'),
            document.querySelector('#productDetailsTable'),
            ...document.querySelectorAll('.a-section.a-spacing-small')
        ].filter(Boolean);

        for (let container of containers) {
            const text = container.innerText;
            if (pubKeywords.some(keyword => text.includes(keyword))) {
                return true;
            }
        }

        return false;
    }

    // BUTTON INSERTION - Adds Goodreads Button after Book Cover
    function addButton() {
        if (document.getElementById('open-in-goodreads-btn')) return;

        const imageBlock =
            document.getElementById('imageBlockNew_feature_div') ||
            document.getElementById('booksImageBlock_feature_div') ||
            document.getElementById('imageBlock_feature_div');

        if (!imageBlock) return;

        // Only add button if this is a book
        if (!isBookPage()) return;

        // Goodreads "g" icon (embedded so Amazon's page rules can't block it)
        const GOODREADS_ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAD7UlEQVR4Ae2aPUxTURTHD+rY7rSzLSsfjih1EymJgxpkI1EIRiGIkhgSARPRyFeEgViNDiYtioOxRdiEyOjXQDS0DMrQkjj2TSz6/g/e43H7qO/c+9IXEn4JCY+W5vzP/d9zz7lQ9Wfz5186xByjQ86RAL85QT6SzeVofHKGikWNYk2nqetaB3HxTUC+UKBbdwapUNgynrO5DQqHqqk13sz5GP8slM4sWcGbfPn6nbj4IgDZT72eL/l5Q30tcfHcQsViUQ9wy/B1MBgwbBEMBve9J/HspfG6nfa2S2z7AE8EIOjk3FtKLyyW2AIgs60tzUaAyH56YWnf67f7btIVXYAMVaoncXJunhLPSzPqBFYD5HdF4nlibJSikZMki9IKjE/NUGqu1MuwTvx8M4XD1YYwVJjllU9W4ADBJ2anKbQrShZpAU91HzsFDy93Xu0wRNhB8J3dPZbFotGTysEDqSoEr8M2IjiI+nU/i8EDZDz16oUV9PLKql42v5EqUgKQfREEj8yXA8JG7t21nofvP3S1d8rBFgAvi5UmGon8N3j7e80Vgq2SDjbkICVAZHLsAbkFwQcCexZTtRFbQF7IfkN9HXszhm3vR/ugYiNlAa0t54gLymq5z+Sg3AtFoxHW+3ESixnXtCLJwhZQI5yaYaZ9nDrOQCBIsrAFiBnXmP4VSzA2dU1UvpVgCxA7xvxWgdzi1OyhCKjAFgDLxJoared0ZtHV78H7Tgdge9tFUkFqE/f39VilE62xm1o+oTd+YvYxB1d8BQBWwX549Q8MHrgSmBXQxKH3ET8Dc4AqSvPAkN7LZBb2Asfggqyiv0e217M5ynxYKimb2LhopVXmABMlAfELlx0nsHLAMmjovGilgdI8YA8e2azRS+xnfT84j5V1xobFCnmJlAA0dPZ5wJyuzC5zZwrLGd/jZ6HqkOOM4AVsC6Ecdnb37sty5t0bzyzBhV2FVvRqYg8eg4xfwQO2hd4L5bK+rtYolfZKU9Q069nslWAh8X7IC9gCEJydruu95BaIiJ1ppLh+R3SqQe0AM+H3Qi382zMTrApObogen5omLzg+0HdjmPMLyJymr8Kv35u0vb1d8nooFDKsYn5pmnO3urb2Q99LBeWyqnSQIQATBH4QZlnFAC+2FInZJ0r9kNJEhqDNr3LA+why4vFoyQ30x+VVUqHi1+ui2IMs5paKCkC5FVtv+xWLDOwyipM4mZo3bhZ22oSd+3/UewTj1DKYF7xOE9nZWCOpwBaAwUTciLJgX1R8oFnPbpAXoHu135PKwi6jKIdDI4+sbtPEqRLZyyyAvXA3isswmT8nOVF19L8SPnMkwG/+AQTLvl21rrg3AAAAAElFTkSuQmCC';

        // Style: Goodreads brand colours, cream pill with brown text
        if (!document.getElementById('open-in-goodreads-style')) {
            const style = document.createElement('style');
            style.id = 'open-in-goodreads-style';
            style.textContent = `
                #open-in-goodreads-btn {
                    margin: 10px auto;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    height: 34px;
                    padding: 0 16px;
                    background: #f4f1ea;
                    border: 1px solid #d6d0c4;
                    border-radius: 20px;
                    color: #382110;
                    font: 13px/1 "Amazon Ember", Arial, sans-serif;
                    cursor: pointer;
                    transition: background-color .15s, border-color .15s;
                }
                #open-in-goodreads-btn:hover { background: #ece6d9; border-color: #c7bfae; }
                #open-in-goodreads-btn:active { background: #e3dccb; }
                #open-in-goodreads-btn img { width: 18px; height: 18px; border-radius: 3px; display: block; }
                #open-in-goodreads-btn b { font: 700 15px/1 Georgia, "Times New Roman", serif; color: #382110; }
            `;
            document.head.appendChild(style);
        }

        const button = document.createElement('button');
        button.id = 'open-in-goodreads-btn';
        button.type = 'button';
        button.title = 'Open this book on Goodreads';

        const logo = document.createElement('img');
        logo.src = GOODREADS_ICON_DATA_URI;
        logo.alt = '';
        const label = document.createElement('span');
        label.textContent = 'View on ';
        const brand = document.createElement('b');
        brand.textContent = 'goodreads';
        button.append(logo, label, brand);

        button.onclick = redirectToGoodreads;

        const wrapper = document.createElement('div');
        wrapper.style.textAlign = 'center';
        wrapper.appendChild(button);

        imageBlock.parentNode.insertBefore(wrapper, imageBlock.nextSibling);
    }

    // OBSERVER - Detects when the target elements are available and then stops observing once the button is added
    const observer = new MutationObserver(() => {
        const found =
            document.getElementById('imageBlock_feature_div') ||
            document.getElementById('imageBlockNew_feature_div') ||
            document.getElementById('booksImageBlock_feature_div');

        if (found) {
            addButton();
            observer.disconnect();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // The image block may already be on the page when this runs; with no
    // later DOM changes the observer alone would never add the button.
    if (document.getElementById('imageBlock_feature_div') ||
        document.getElementById('imageBlockNew_feature_div') ||
        document.getElementById('booksImageBlock_feature_div')) {
        addButton();
        if (document.getElementById('open-in-goodreads-btn')) observer.disconnect();
    }
})();