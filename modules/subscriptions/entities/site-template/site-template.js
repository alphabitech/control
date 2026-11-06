
'use strict';

import {BaseDocument} from 'loopar';

/**
 * A website template offered on Loopar Cloud: an installable app (`name`)
 * with neutral sample content and a live demo. Checkout will carry the
 * chosen template as `template` metadata so provisioning can install it.
 */
export default class SiteTemplate extends BaseDocument {
    constructor(props){
        super(props);
    }
}
