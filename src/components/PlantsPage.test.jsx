import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PlantsPage from './PlantsPage';
import { usePlants } from '../hooks/usePlants';

jest.mock('../hooks/usePlants', () => ({ usePlants: jest.fn() }));
jest.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'user-1' } }) }));
jest.mock('./PlantCard', () => () => <article className='plantWrap' />);
jest.mock('./PlantForm', () => () => null);
jest.mock('./ScrollToTop', () => () => null);
jest.mock('./Footer', () => () => null);
jest.mock('../i/icons/grid-3-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-4-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-8-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-1-column.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-2-columns.svg', () => ({ ReactComponent: () => <svg /> }));

const originalWidth = window.innerWidth;

function resize(width) {
    act(() => {
        window.innerWidth = width;
        window.dispatchEvent(new Event('resize'));
    });
}

function renderPage() {
    return render(<MemoryRouter><PlantsPage /></MemoryRouter>);
}

beforeEach(() => {
    localStorage.clear();
    usePlants.mockReturnValue({
        plants: [{ id: 'plant-1' }],
    });
});

afterEach(() => {
    window.innerWidth = originalWidth;
});

test.each([
    [1920, 8, [3, 4]], [1681, 8, [3, 4]], [1680, 8, [3]], [1679, 7, [3]], [1440, 7, [3]],
    [1439, 6, [2]], [1280, 6, [2]], [1279, 5, [2]], [481, 5, [2]],
    [480, null, [3, 4]], [375, null, [3, 4]],
])('offers the right compact grid at %i px', (width, compactColumns, regularColumns) => {
    resize(width);
    localStorage.setItem('plantsGridColumns', '8');
    renderPage();
    const controls = within(screen.getByRole('group', { name: 'Вид карточек' }));

    expect(controls.getAllByRole('button')).toHaveLength(regularColumns.length + (compactColumns ? 1 : 0));
    expect(controls.queryAllByRole('button', { name: /^Средние:/ })).toHaveLength(regularColumns.length - 1);
    regularColumns.forEach((columns, index) => {
        expect(controls.getByRole('button', { name: `${index === 0 ? 'Крупные' : 'Средние'}: ${columns} карточки в ряду` }))
            .toHaveAttribute('aria-pressed', !compactColumns && columns === 4 ? 'true' : 'false');
    });
    const compactButtons = controls.queryAllByRole('button', { name: /^Компактные:/ });
    expect(compactButtons).toHaveLength(compactColumns ? 1 : 0);
    compactButtons.forEach((button) => {
        expect(button).toHaveAccessibleName(`Компактные: ${compactColumns} карточек в ряду`);
        expect(button).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByRole('list', { name: 'Растения' }))
        .toHaveClass(`plantListWrap--columns-${compactColumns || 4}`);
});

test('adapts compact mode on resize and keeps mobile selection independent', () => {
    resize(1680);
    renderPage();
    const grid = screen.getByRole('list', { name: 'Растения' });
    fireEvent.click(screen.getByRole('button', { name: 'Компактные: 8 карточек в ряду' }));
    expect(localStorage.getItem('plantsGridColumns')).toBe('8');

    for (const [width, columns] of [[1679, 7], [1439, 6], [1279, 5], [481, 5], [480, 4]]) {
        resize(width);
        expect(grid).toHaveClass(`plantListWrap--columns-${columns}`);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид: 2 карточки в ряду' }));
    expect(grid).toHaveClass('plantListWrap--mobile-compact');
    expect(localStorage.getItem('plantsMobileCompact')).toBe('true');

    resize(1680);
    expect(grid).toHaveClass('plantListWrap--columns-8');
    resize(1280);
    fireEvent.click(screen.getByRole('button', { name: 'Крупные: 2 карточки в ряду' }));
    resize(1680);
    expect(grid).toHaveClass('plantListWrap--columns-3');
    resize(1681);
    fireEvent.click(screen.getByRole('button', { name: 'Средние: 4 карточки в ряду' }));
    expect(grid).toHaveClass('plantListWrap--columns-4');
    resize(1680);
    expect(grid).toHaveClass('plantListWrap--columns-3');
    resize(1681);
    expect(grid).toHaveClass('plantListWrap--columns-4');
});

test('adapts full cards to the available choices and remembers two columns', () => {
    resize(1440);
    const { unmount } = renderPage();
    const grid = screen.getByRole('list', { name: 'Растения' });
    for (const [width, columns] of [[1439, 2], [1280, 2], [1279, 2], [481, 2], [1440, 3]]) {
        resize(width);
        expect(grid).toHaveClass(`plantListWrap--columns-${columns}`);
    }
    resize(1280);
    fireEvent.click(screen.getByRole('button', { name: 'Крупные: 2 карточки в ряду' }));
    expect(localStorage.getItem('plantsGridColumns')).toBe('2');
    unmount();
    renderPage();
    expect(screen.getByRole('list', { name: 'Растения' })).toHaveClass('plantListWrap--columns-2');
    resize(1440);
    expect(screen.getByRole('list', { name: 'Растения' })).toHaveClass('plantListWrap--columns-3');
});
