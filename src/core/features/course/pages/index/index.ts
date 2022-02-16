// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, ViewChild, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Params } from '@angular/router';

import { CoreTabsOutletTab, CoreTabsOutletComponent } from '@components/tabs-outlet/tabs-outlet';
import { CoreCourseFormatDelegate } from '../../services/format-delegate';
import { CoreCourseOptionsDelegate } from '../../services/course-options-delegate';
import { CoreCourseAnyCourseData } from '@features/courses/services/courses';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { CoreCourse, CoreCourseModuleCompletionStatus, CoreCourseWSSection } from '@features/course/services/course';
import { CoreCourseHelper, CoreCourseModuleData } from '@features/course/services/course-helper';
import { CoreUtils } from '@services/utils/utils';
import { CoreTextUtils } from '@services/utils/text';
import { CoreNavigationOptions, CoreNavigator } from '@services/navigator';
import { CONTENTS_PAGE_NAME } from '@features/course/course.module';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreCollapsibleHeaderDirective } from '@directives/collapsible-header';
import { CoreCourseSummaryPage } from '../course-summary/course-summary';

/**
 * Page that displays the list of courses the user is enrolled in.
 */
@Component({
    selector: 'page-core-course-index',
    templateUrl: 'index.html',
    styleUrls: ['index.scss'],
})
export class CoreCourseIndexPage implements OnInit, OnDestroy {

    @ViewChild(CoreTabsOutletComponent) tabsComponent?: CoreTabsOutletComponent;
    @ViewChild(CoreCollapsibleHeaderDirective) ionCollapsibleHeader?: CoreCollapsibleHeaderDirective;

    title = '';
    category = '';
    course?: CoreCourseAnyCourseData;
    tabs: CourseTab[] = [];
    loaded = false;
    imageThumb?: string;
    progress?: number;

    protected currentPagePath = '';
    protected selectTabObserver: CoreEventObserver;
    protected completionObserver: CoreEventObserver;
    protected sections: CoreCourseWSSection[] = []; // List of course sections.
    protected firstTabName?: string;
    protected module?: CoreCourseModuleData;
    protected modNavOptions?: CoreNavigationOptions;
    protected isGuest = false;
    protected contentsTab: CoreTabsOutletTab & { pageParams: Params } = {
        page: CONTENTS_PAGE_NAME,
        title: 'core.course',
        pageParams: {},
    };

    constructor(private route: ActivatedRoute) {
        this.selectTabObserver = CoreEvents.on(CoreEvents.SELECT_COURSE_TAB, (data) => {
            if (!data.name) {
                // If needed, set sectionId and sectionNumber. They'll only be used if the content tabs hasn't been loaded yet.
                if (data.sectionId) {
                    this.contentsTab.pageParams.sectionId = data.sectionId;
                }
                if (data.sectionNumber) {
                    this.contentsTab.pageParams.sectionNumber = data.sectionNumber;
                }

                // Select course contents.
                this.tabsComponent?.selectByIndex(0);
            } else if (this.tabs) {
                const index = this.tabs.findIndex((tab) => tab.name == data.name);

                if (index >= 0) {
                    this.tabsComponent?.selectByIndex(index);
                }
            }
        });

        // The completion of any of the modules have changed.
        this.completionObserver = CoreEvents.on(CoreEvents.COMPLETION_CHANGED, (data) => {
            if (data.completion.courseId != this.course?.id) {
                return;
            }

            if (data.completion.valueused !== false || !this.course || !('progress' in this.course) ||
                    typeof this.course.progress != 'number') {
                return;
            }

            // If the completion value is not used, the page won't be reloaded, so update the progress bar.
            const completionModules = (<CoreCourseModuleData[]> [])
                .concat(...this.sections.map((section) => section.modules))
                .map((module) => module.completion && module.completion > 0 ? 1 : module.completion)
                .reduce((accumulator, currentValue) => (accumulator || 0) + (currentValue || 0), 0);

            const moduleProgressPercent = 100 / (completionModules || 1);
            // Use min/max here to avoid floating point rounding errors over/under-flowing the progress bar.
            if (data.completion.state === CoreCourseModuleCompletionStatus.COMPLETION_COMPLETE) {
                this.course.progress = Math.min(100, this.course.progress + moduleProgressPercent);
            } else {
                this.course.progress = Math.max(0, this.course.progress - moduleProgressPercent);
            }

            this.updateProgress();
        });
    }

    /**
     * @inheritdoc
     */
    async ngOnInit(): Promise<void> {
        // Increase route depth.
        const path = CoreNavigator.getRouteFullPath(this.route.snapshot);

        CoreNavigator.increaseRouteDepth(path.replace(/(\/deep)+/, ''));

        try {
            this.course = CoreNavigator.getRequiredRouteParam('course');
        } catch (error) {
            CoreDomUtils.showErrorModal(error);
            CoreNavigator.back();

            return;
        }

        this.firstTabName = CoreNavigator.getRouteParam('selectedTab');
        this.module = CoreNavigator.getRouteParam<CoreCourseModuleData>('module');
        this.isGuest = !!CoreNavigator.getRouteBooleanParam('isGuest');
        this.modNavOptions = CoreNavigator.getRouteParam<CoreNavigationOptions>('modNavOptions');
        if (!this.modNavOptions) {
            // Fallback to old way of passing params. @deprecated since 4.0.
            const modParams = CoreNavigator.getRouteParam<Params>('modParams');
            if (modParams) {
                this.modNavOptions = { params: modParams };
            }
        }

        this.currentPagePath = CoreNavigator.getCurrentPath();
        this.contentsTab.page = CoreTextUtils.concatenatePaths(this.currentPagePath, this.contentsTab.page);
        this.contentsTab.pageParams = {
            course: this.course,
            sectionId: CoreNavigator.getRouteNumberParam('sectionId'),
            sectionNumber: CoreNavigator.getRouteNumberParam('sectionNumber'),
            isGuest: this.isGuest,
        };

        if (this.module) {
            this.contentsTab.pageParams.moduleId = this.module.id;
        }

        this.tabs.push(this.contentsTab);
        this.loaded = true;

        await Promise.all([
            this.loadCourseHandlers(),
            this.loadBasinInfo(),
        ]);
    }

    /**
     * A tab was selected.
     */
    tabSelected(tabToSelect: CoreTabsOutletTab): void {
        this.ionCollapsibleHeader?.setupContent(tabToSelect.id);

        if (!this.module || !this.course) {
            return;
        }
        // Now that the first tab has been selected we can load the module.
        CoreCourseHelper.openModule(this.module, this.course.id, {
            sectionId: this.contentsTab.pageParams.sectionId,
            modNavOptions: this.modNavOptions,
        });

        delete this.module;
    }

    /**
     * Load course option handlers.
     *
     * @return Promise resolved when done.
     */
    protected async loadCourseHandlers(): Promise<void> {
        if (!this.course) {
            return;
        }

        // Load the course handlers.
        const handlers = await CoreCourseOptionsDelegate.getHandlersToDisplay(this.course, false, this.isGuest);

        let tabToLoad: number | undefined;

        // Create the full path.
        handlers.forEach((handler, index) => {
            handler.data.page = CoreTextUtils.concatenatePaths(this.currentPagePath, handler.data.page);
            handler.data.pageParams = handler.data.pageParams || {};

            // Check if this handler should be the first selected tab.
            if (this.firstTabName && handler.name == this.firstTabName) {
                tabToLoad = index + 1;
            }
        });

        this.tabs = [...this.tabs, ...handlers.map(handler => ({
            ...handler.data,
            name: handler.name,
        }))];

        // Select the tab if needed.
        this.firstTabName = undefined;
        if (tabToLoad) {
            setTimeout(() => {
                this.tabsComponent?.selectByIndex(tabToLoad!);
            });
        }
    }

    /**
     * Load title for the page.
     *
     * @return Promise resolved when done.
     */
    protected async loadBasinInfo(): Promise<void> {
        if (!this.course) {
            return;
        }

        // Get the title to display initially.
        this.title = CoreCourseFormatDelegate.getCourseTitle(this.course);
        this.category = 'categoryname' in this.course ? this.course.categoryname : '';

        if ('overviewfiles' in this.course) {
            this.imageThumb = this.course.overviewfiles?.[0]?.fileurl;
        }

        this.updateProgress();

        // Load sections.
        this.sections = await CoreUtils.ignoreErrors(CoreCourse.getSections(this.course.id, false, true), []);

        if (!this.sections) {
            return;
        }

        // Get the title again now that we have sections.
        this.title = CoreCourseFormatDelegate.getCourseTitle(this.course, this.sections);
    }

    /**
     * @inheritdoc
     */
    ngOnDestroy(): void {
        const path = CoreNavigator.getRouteFullPath(this.route.snapshot);

        CoreNavigator.decreaseRouteDepth(path.replace(/(\/deep)+/, ''));
        this.selectTabObserver?.off();
        this.completionObserver?.off();
    }

    /**
     * User entered the page.
     */
    ionViewDidEnter(): void {
        this.tabsComponent?.ionViewDidEnter();
    }

    /**
     * User left the page.
     */
    ionViewDidLeave(): void {
        this.tabsComponent?.ionViewDidLeave();
    }

    /**
     * Open the course summary
     */
    openCourseSummary(): void {
        if (!this.course) {
            return;
        }

        CoreDomUtils.openSideModal<void>({
            component: CoreCourseSummaryPage,
            componentProps: {
                courseId: this.course.id,
                course: this.course,
            },
        });
    }

    /**
     * Update course progress.
     */
    protected updateProgress(): void {
        if (
            !this.course ||
                !('progress' in this.course) ||
                typeof this.course.progress !== 'number' ||
                this.course.progress < 0 ||
                this.course.completionusertracked === false
        ) {
            this.progress = undefined;

            return;
        }

        this.progress = this.course.progress;
    }

}

type CourseTab = CoreTabsOutletTab & {
    name?: string;
};
