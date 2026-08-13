# The U.S. Teletext Archive

![images/white-logo-2.png](images/logo-white-2.png)

## Repository Information

This repository contains code and files for a website that will host information about and pages for decoded U.S. teletext. This website is a work in progress. As more progress is made, this README will be updated.

In this repository are the main HTML pages. Also included are the following directories:

- `css` contains the style sheets for the website, such as the main style sheets. SASS is used in this project.
- `fonts` contains any external fonts used on the site.
- `html` contains all HTML pages except for the index.html file.
- `images` contains images used on the site.
- `js` contains the scripts used on the site.
- `json` contains JSON files that are used to display database record information on the site.
- `php` contains any PHP scripts used for backend purposes.

## Some Background
For the last few years, European teletext has been able to be decoded thanks to software tools such as [VHS-Teletext](https://github.com/ali1234/vhs-teletext). However, due to the different broadcast standards used in both Europe and the U.S. (PAL vs NTSC), there had been no working method to decode North American teletext. Another issue was that the U.S. has two teletext standards: World System Teletext (WST, also used in Europe) and the North American Broadcast Teletext Specification (NABTS). Also, teletext was not as popular in the U.S. as it was in Europe.

In August 2026, a milestone was reached: U.S. teletext could now be properly decoded thanks to the further development of [Decode-Orc](https://github.com/decode-orc/decode-orc). With this development, pages from U.S. teletext services such as will finally be seen for the first time since these pages were transmitted via the networks' VBI, possibly for the first time ever. Some of the teletext services available in the U.S. follow:

- **Electra** (primarily used by TBS) *(appx. 1982 - appx. 1993)* **[WST]**
- **ExtraVision** (CBS's teletext service) *(appx. 1984 - appx. 1990)* **[NABTS]**
- **Keyfax** (primarily used by TBS) *(appx. 1982 - appx. 1985)* **[WST]**
- **NBC Teletext** (NBC's teletext service) *(May 16, 1983 - appx. 1985)* **[NABTS]**

\*NOTE: Keyfax was transmitted on TBS from 1982-1985. Electra took over teletext services on TBS after Keyfax's closure.

## Overall Purpose

With there being existing software tools to decode European teletext, there are a few websites dedicated to hosting archives of those European services, such as the BBC's Ceefax service. Now, with there being available software to decode North American NABTS and WST services, a proper archival website was needed to host these newly-decoded samples - that's the purpose of this website. The goal is to make these samples widely available to anyone who wants download them. Samples are provided as ZIP files. Included in the ZIP archives are the decoded images and, depending on the service, a T33 (NABTS) or T34 (WST) file, which contains the raw, decoded teletext stream.

Created August 10, 2026, 13:50

Updated August 13, 2026, 17:51